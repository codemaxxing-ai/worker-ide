/**
 * esbuild ↔ PluginContainer bridge.
 *
 * Because workerd forbids code generation from strings, server environments
 * cannot be lazily evaluated by a Vite module runner; they must be delivered to
 * the LOADER isolate as real ES modules. This bridge produces that module set:
 * esbuild walks the graph while delegating every `resolveId`/`load`/`transform`
 * decision to the {@link PluginContainer} (so vinext + plugin-rsc drive the
 * build), falling back to the in-memory project filesystem for ordinary files.
 *
 * The result is one bundled ESM string per environment, content-addressable and
 * ready to hand to `env.LOADER`.
 */
import { WorkerBuildBudget } from '@shared/worker-resource-budget';

import { conditionsForEnvironment } from './conditions';
import {
	buildEsmCdnUrl,
	ESM_CDN_NAMESPACE,
	fetchEsmModule,
	isEsmCdnExcluded,
	readDependencyVersions,
	resolveEsmCdnImport,
} from './esm-cdn';
import { normalizePosixPath } from './node-fs/memory-file-system';
import { parsePackageSpecifier, resolvePackage } from './package-resolver';
import { applyAlias } from './resolve-alias';
import { parse as lexParse } from './runtime/es-module-lexer-shim';
import {
	isReactClosureSpecifier,
	REACT_CLOSURE_EXTERNAL_MARKER,
	reactRuntimeShimContents,
	runtimeImportPath,
} from './runtime/react-runtime-modules';
import { VINEXT_RUNTIME_DIST_ROOT } from './runtime/vinext-runtime-paths';

import type { Esbuild } from './esbuild-runtime';
import type { MemoryFileSystem } from './node-fs/memory-file-system';
import type { PluginContainer } from './plugin-container';
import type { AliasConfig, ViteEnvironmentName } from './types';
import type { Loader, Plugin as EsbuildPlugin } from 'esbuild-wasm';

const NAMESPACE = 'vite-host';

/** Namespace for browser-client stubs of `node:` builtins (empty CJS module). */
const NODE_STUB_NAMESPACE = 'vite-host-node-stub';

/**
 * Namespace for the React-closure ESM re-export shim. A closure import
 * (`react`, `react-dom`, `scheduler`, …) resolves here; the shim re-exports the
 * external shared runtime module, converting a CommonJS `require` into a static
 * ESM `import` (see `runtime/react-runtime-modules`).
 */
const REACT_SHIM_NAMESPACE = 'vite-host-react-shim';

/**
 * Prepended to the client entry in host development mode: exposes the bundled
 * runtime's React (the single instance react-dom uses) on globals so the
 * dev-served, hot-reloaded client components re-export the same instance.
 */
const CLIENT_REACT_GLOBAL_EXPOSE = [
	'import __vinext_react_default from "react";',
	'import __vinext_jsx_default from "react/jsx-runtime";',
	'import __vinext_react_dom_default from "react-dom";',
	'import __vinext_react_dom_client_default from "react-dom/client";',
	'globalThis.__vinext_react = __vinext_react_default;',
	'globalThis.__vinext_jsx_runtime = __vinext_jsx_default;',
	'globalThis.__vinext_react_dom = __vinext_react_dom_default;',
	'globalThis.__vinext_react_dom_client = __vinext_react_dom_client_default;',
	'',
].join('\n');

const RESOLVABLE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.json'];

/**
 * esbuild platform per environment. Server environments use `node` so external
 * `node:*` builtins are emitted as ESM `import`s (not unsupported dynamic
 * `require`s); the client targets the browser.
 */
function platformForEnvironment(environment: ViteEnvironmentName): 'node' | 'browser' {
	return environment === 'client' ? 'browser' : 'node';
}

/**
 * Banner that gives the bundle a real `require` (via `node:module`
 * `createRequire`). esbuild's `__require` shim uses the global `require` when
 * present, so CommonJS `require("node:*")` calls inside bundled dependencies
 * resolve at runtime instead of throwing "Dynamic require is not supported".
 */
const SERVER_REQUIRE_BANNER =
	"import { createRequire as __vinextCreateRequire } from 'node:module'; var require = /* @__PURE__ */ __vinextCreateRequire('file:///worker.js');";

/**
 * The browser has no `process`. vinext's client runtime reads `process.env.*`
 * (with `?? `/`|| ` fallbacks) and guards on `typeof process`, so a minimal
 * `process` stub (with `process.env.NODE_ENV` still inlined via `define`) keeps
 * the client bundle from throwing `ReferenceError: process is not defined`.
 */
const CLIENT_PROCESS_BANNER = 'var process = { env: {} };';

function bannerForEnvironment(environment: ViteEnvironmentName): { js: string } | undefined {
	return environment === 'client' ? { js: CLIENT_PROCESS_BANNER } : { js: SERVER_REQUIRE_BANNER };
}

export interface BundleModuleGraphOptions {
	esbuild: Esbuild;
	container: PluginContainer;
	fileSystem: MemoryFileSystem;
	/** Entry module id — may be a virtual id (e.g. `virtual:vinext-rsc-entry`). */
	entryId: string;
	environment: ViteEnvironmentName;
	/** Bare specifiers to leave external (provided by the runtime isolate). */
	externals: string[];
	/** `resolve.alias` entries to apply before plugin/fs resolution. */
	alias?: AliasConfig;
	/** esbuild `define` substitutions (e.g. `process.env.NODE_ENV`). */
	define?: Record<string, string>;
	/** Whether to emit a sourcemap (inline). */
	sourcemap?: boolean;
	/** Output name for the entry chunk (the Rollup input key, e.g. `index`). */
	entryName?: string;
}

export interface BundleResult {
	code: string;
}

export interface BundleOutputFile {
	/** Output file name relative to the environment's outDir. */
	fileName: string;
	text: string;
	/** True for the entry chunk. */
	isEntry: boolean;
	/** True for CSS output (an asset, not a JS chunk). */
	isCss: boolean;
	/** Source module ids that compose this chunk (from the esbuild metafile). */
	moduleIds: string[];
	/** Other output files this chunk imports. */
	imports: string[];
	/** CSS files this JS chunk pulls in (drives `viteMetadata.importedCss`). */
	importedCss: string[];
}

export interface EnvironmentBundle {
	files: BundleOutputFile[];
	entryFileName: string;
	/** Per-module export names (module id → exported names). */
	moduleExports: Record<string, string[]>;
}

function directoryOf(id: string): string {
	const normalized = normalizePosixPath(id);
	const index = normalized.lastIndexOf('/');
	return index <= 0 ? '/' : normalized.slice(0, index);
}

function loaderForId(id: string): Loader {
	const withoutQuery = id.split('?')[0];
	if (withoutQuery.endsWith('.ts') || withoutQuery.endsWith('.mts')) return 'ts';
	if (withoutQuery.endsWith('.tsx')) return 'tsx';
	if (withoutQuery.endsWith('.jsx')) return 'jsx';
	if (withoutQuery.endsWith('.json')) return 'json';
	if (withoutQuery.endsWith('.css')) return 'css';
	// Virtual ids and extensionless modules are emitted as JS by the plugins.
	return 'js';
}

function isBareSpecifier(specifier: string): boolean {
	return !specifier.startsWith('.') && !specifier.startsWith('/');
}

/** Resolve a relative/absolute import against the in-memory filesystem. */
function resolveAgainstFileSystem(importer: string, specifier: string, fileSystem: MemoryFileSystem): string | undefined {
	const base = specifier.startsWith('/') ? specifier : `${directoryOf(importer)}/${specifier}`;
	const normalized = normalizePosixPath(base);
	if (fileSystem.exists(normalized) && fileSystem.stat(normalized).isFile()) {
		return normalized;
	}
	for (const extension of RESOLVABLE_EXTENSIONS) {
		if (fileSystem.exists(normalized + extension)) {
			return normalized + extension;
		}
	}
	for (const extension of RESOLVABLE_EXTENSIONS) {
		const indexPath = `${normalized}/index${extension}`;
		if (fileSystem.exists(indexPath)) {
			return indexPath;
		}
	}
	return undefined;
}

/**
 * Recover the intended specifier from a `file://` URL. vinext/plugin-rsc
 * occasionally build `new URL(id, import.meta.url)` against the pinned runtime
 * dirname, producing e.g. `file:///@vitejs/plugin-rsc/react/rsc` for a bare
 * specifier. Strip the scheme; if the path is not a real project/runtime file,
 * treat a leading-slash scoped/bare path as the bare specifier.
 */
function normalizeFileUrlSpecifier(specifier: string, fileSystem: MemoryFileSystem): string {
	if (!specifier.startsWith('file://')) {
		return specifier;
	}
	const pathname = specifier.slice('file://'.length);
	if (fileSystem.exists(pathname)) {
		return pathname;
	}
	// `/@scope/pkg` or `/pkg/...` that is not a real file → a bare specifier.
	return pathname.replace(/^\//, '');
}

/** Dependencies the default (non-plugin) resolver needs. */
interface DefaultResolveContext {
	fileSystem: MemoryFileSystem;
	externals: string[];
	alias?: AliasConfig;
}

/**
 * Resolve a specifier the way the bridge does *after* the plugin `resolveId`
 * chain declines: alias + `file://` recovery, vinext runtime subpaths, vendored
 * node_modules (conditions-aware), configured externals, then the project
 * filesystem. Shared so the PluginContainer's `this.resolve` falls back to the
 * same resolution Rollup performs (returning a result, not `undefined`) — which
 * plugin-rsc relies on when resolving client references.
 */
function defaultResolveSpecifier(
	source: string,
	importer: string | undefined,
	environment: ViteEnvironmentName,
	context: DefaultResolveContext,
): { id: string; external: boolean } | undefined {
	const normalized = normalizeFileUrlSpecifier(source, context.fileSystem);
	const aliased = applyAlias(normalized, context.alias);
	const specifier = aliased ?? normalized;

	if (aliased !== undefined && !isBareSpecifier(aliased)) {
		const aliasResolved = resolveAgainstFileSystem(importer ?? '/', aliased, context.fileSystem);
		if (aliasResolved !== undefined) {
			return { id: aliasResolved, external: false };
		}
	}

	const vinextResolved = resolveVinextSubpath(specifier, context.fileSystem);
	if (vinextResolved !== undefined) {
		return { id: vinextResolved, external: false };
	}

	if (isBareSpecifier(specifier)) {
		// React-closure imports resolve to the shared runtime module, left external
		// (the single instance every environment references). Reported here too so
		// plugins re-resolving via `this.resolve` (plugin-rsc) see the same result.
		if (isReactClosureSpecifier(specifier, environment)) {
			return { id: runtimeImportPath(environment, specifier), external: true };
		}
		const packageResolved = resolvePackage(specifier, context.fileSystem, conditionsForEnvironment(environment));
		if (packageResolved !== undefined) {
			return { id: packageResolved.path, external: false };
		}
		// Configured or unconfigured bare imports are left external for the runtime.
		return { id: specifier, external: true };
	}

	const fsResolved = resolveAgainstFileSystem(importer ?? '/', specifier, context.fileSystem);
	return fsResolved === undefined ? undefined : { id: fsResolved, external: false };
}

/**
 * Resolve vinext's own package subpaths (`vinext/metadata`, `vinext/server/*`,
 * …) to the seeded runtime tree. In a normal install these resolve via node
 * module resolution; here the runtime is mirrored under the deterministic
 * `/__vinext__/dist` root.
 */
function resolveVinextSubpath(specifier: string, fileSystem: MemoryFileSystem): string | undefined {
	// Bare `vinext` is the Vite *plugin* entry (build-time only); it must never
	// be pulled into the app runtime graph. Only `vinext/<subpath>` runtime
	// modules resolve to the seeded dist.
	if (!specifier.startsWith('vinext/')) {
		return undefined;
	}
	const subpath = specifier.slice('vinext/'.length);
	const candidate = `${VINEXT_RUNTIME_DIST_ROOT}/${subpath}`;
	if (fileSystem.exists(candidate) && fileSystem.stat(candidate).isFile()) {
		return candidate;
	}
	for (const extension of RESOLVABLE_EXTENSIONS) {
		if (fileSystem.exists(candidate + extension)) {
			return candidate + extension;
		}
	}
	return undefined;
}

function createBridgePlugin(options: BundleModuleGraphOptions, moduleExports?: Map<string, string[]>): EsbuildPlugin {
	const { container, fileSystem, environment, externals } = options;
	const dependencyBudget = new WorkerBuildBudget();
	const ssr = environment !== 'client';

	// Give the container's `this.resolve` the same default resolution the bridge
	// performs, so plugins that re-resolve (plugin-rsc client references) get a
	// concrete result instead of `undefined`.
	container.setDefaultResolve((source, importer, environmentName) =>
		defaultResolveSpecifier(source, importer, environmentName, { fileSystem, externals, alias: options.alias }),
	);

	// The CLIENT entry id, captured during resolution, so its module can be
	// prefixed with the React global-expose in host development mode.
	let clientEntryId: string | undefined;

	// Versions for esm.sh fallback (registered third-party deps not in the
	// vendored node_modules), pinned from the project's package.json.
	const dependencyVersions = readDependencyVersions(fileSystem);

	/**
	 * A bare specifier the vendored `node_modules` can't resolve. If it's a
	 * registered project dependency, fetch it from esm.sh at build time instead
	 * of leaving it as a bare external that fails to load at runtime. React-family
	 * deps and unregistered specifiers keep the previous (external) behaviour.
	 */
	const routeUnresolvedBare = (specifier: string): { path: string; namespace?: string; external?: boolean } => {
		const { packageName } = parsePackageSpecifier(specifier);
		const version = dependencyVersions.get(packageName);
		// Only registered runtime dependencies are CDN-fetched. React-family deps
		// and anything not in `dependencies` (toolchain, build-time-only) keep the
		// previous external behaviour.
		if (version === undefined || isEsmCdnExcluded(packageName)) {
			return { path: specifier, external: true };
		}
		return { path: buildEsmCdnUrl(specifier, version), namespace: ESM_CDN_NAMESPACE };
	};

	return {
		name: 'vite-host-bridge',
		setup(build) {
			// Imports *inside* an esm.sh module: relative/absolute paths resolve
			// against the module's esm.sh URL; bare specifiers resolve to the
			// vendored instance when possible (dedupes React), else fetch from
			// esm.sh too (deep transitive deps).
			build.onResolve({ filter: /.*/, namespace: ESM_CDN_NAMESPACE }, (arguments_) => {
				if (arguments_.path.startsWith('node:')) {
					return environment === 'client'
						? { path: arguments_.path, namespace: NODE_STUB_NAMESPACE }
						: { path: arguments_.path, external: true };
				}
				if (arguments_.path.startsWith('.') || arguments_.path.startsWith('/')) {
					return { path: resolveEsmCdnImport(arguments_.importer, arguments_.path), namespace: ESM_CDN_NAMESPACE };
				}
				const vendored = defaultResolveSpecifier(arguments_.path, undefined, environment, {
					fileSystem,
					externals,
					alias: options.alias,
				});
				if (vendored !== undefined && !vendored.external) {
					return { path: vendored.id, namespace: NAMESPACE };
				}
				// Do NOT trigger new esm.sh fetches transitively from within a fetched
				// module. esm.sh bundles a package's own dependencies (we only
				// externalize the React family), so a stray bare import here is a
				// peer/runtime dep best left external rather than cascading into more
				// fetches (e.g. `vite` → `@vitejs/devtools` → `devframe`, which 404).
				return { path: arguments_.path, external: true };
			});

			build.onLoad({ filter: /.*/, namespace: ESM_CDN_NAMESPACE }, async (arguments_) => {
				const source = await fetchEsmModule(arguments_.path);
				dependencyBudget.addSource(source);
				return { contents: source, loader: 'js' };
			});

			build.onResolve({ filter: /.*/ }, async (arguments_) => {
				// esm.sh-namespace imports are handled by the dedicated resolver above.
				if (arguments_.namespace === ESM_CDN_NAMESPACE) {
					return;
				}
				// The React-closure shim's re-export target → the external shared
				// runtime module. Crossed by ESM `export * from`, so esbuild emits a
				// real `import` the workerd module worker resolves (a CommonJS
				// `require` would become an unresolvable `__require` shim).
				if (arguments_.path.startsWith(REACT_CLOSURE_EXTERNAL_MARKER)) {
					return {
						path: runtimeImportPath(environment, arguments_.path.slice(REACT_CLOSURE_EXTERNAL_MARKER.length)),
						external: true,
					};
				}
				const importer = arguments_.kind === 'entry-point' ? undefined : arguments_.importer;

				// Node builtins: on the server, defer to esbuild's platform-`node`
				// resolver (hoists CommonJS `require("node:*")` to an ESM import). On
				// the browser client they must NOT remain as bare `import "node:*"`
				// (the browser can't load them); resolve them to an empty stub so
				// named imports become `undefined`. vinext's client shims guard these
				// (e.g. `typeof AsyncLocalStorage === 'function' ? … : noop`), so the
				// empty stub is the browser-safe behaviour.
				if (arguments_.path.startsWith('node:')) {
					return environment === 'client' ? { path: arguments_.path, namespace: NODE_STUB_NAMESPACE } : undefined;
				}

				// The client-references map's dev URLs are resolved by the browser at
				// runtime (unbundled, hot-reloaded client components), never bundled.
				if (arguments_.path.startsWith('/@vinext-client/') || arguments_.path.startsWith('/@vinext-client-dep/')) {
					return { path: arguments_.path, external: true };
				}

				const requestPath = normalizeFileUrlSpecifier(arguments_.path, fileSystem);

				// React-closure imports (incl. the CommonJS `require`s inside the
				// still-bundled, plugin-rsc-patched react-server-dom-webpack) resolve
				// to the shared runtime module via an ESM re-export shim — one React
				// instance per environment, referenced rather than inlined.
				if (arguments_.kind !== 'entry-point' && isReactClosureSpecifier(requestPath, environment)) {
					return { path: requestPath, namespace: REACT_SHIM_NAMESPACE };
				}

				// 1. `resolve.alias` (vinext maps `next/*` and config aliases to its
				// seeded shim files). Aliased targets resolve as project files.
				const aliased = applyAlias(requestPath, options.alias);
				const specifier = aliased ?? requestPath;
				if (aliased !== undefined && !isBareSpecifier(aliased)) {
					const aliasResolved = resolveAgainstFileSystem(importer ?? '/', aliased, fileSystem);
					if (aliasResolved !== undefined) {
						return { path: aliasResolved, namespace: NAMESPACE };
					}
				}

				// 2. Plugin resolution (vinext + plugin-rsc).
				const resolved = await container.resolveId(specifier, importer, { ssr, environment, importer });
				if (resolved !== undefined) {
					if (arguments_.kind === 'entry-point' && environment === 'client') {
						clientEntryId = resolved.id;
					}
					if (resolved.external) {
						return { path: resolved.id, external: true };
					}
					return { path: resolved.id, namespace: NAMESPACE };
				}

				if (arguments_.kind === 'entry-point') {
					if (environment === 'client') {
						clientEntryId = specifier;
					}
					return { path: specifier, namespace: NAMESPACE };
				}

				// 3. Default resolution (vinext runtime subpaths, vendored
				// node_modules with this environment's conditions, externals, then the
				// project filesystem) — the same fallback the container's
				// `this.resolve` uses.
				const fallback = defaultResolveSpecifier(specifier, importer, environment, { fileSystem, externals, alias: options.alias });
				if (fallback !== undefined) {
					// A bare specifier the vendored node_modules couldn't resolve would
					// otherwise become a bare external that fails at load time
					// (`No such module "<env>/<pkg>"`). If it's a registered project
					// dependency, fetch it from esm.sh and bundle it instead.
					if (fallback.external && isBareSpecifier(fallback.id)) {
						return routeUnresolvedBare(fallback.id);
					}
					return fallback.external ? { path: fallback.id, external: true } : { path: fallback.id, namespace: NAMESPACE };
				}
				return { errors: [{ text: `Could not resolve "${specifier}" from "${importer ?? '<entry>'}"` }] };
			});

			// Empty CJS module for client-side `node:` builtin stubs. CommonJS (not
			// ESM) so any named import (`{ AsyncLocalStorage }`) resolves to
			// `undefined` instead of an esbuild "no matching export" error.
			build.onLoad({ filter: /.*/, namespace: NODE_STUB_NAMESPACE }, () => ({ contents: 'module.exports = {};', loader: 'js' }));

			// The React-closure shim: an ESM re-export of the external shared runtime
			// module (see the `REACT_CLOSURE_EXTERNAL_MARKER` resolver above).
			build.onLoad({ filter: /.*/, namespace: REACT_SHIM_NAMESPACE }, (arguments_) => ({
				contents: reactRuntimeShimContents(arguments_.path),
				loader: 'js',
			}));

			build.onLoad({ filter: /.*/, namespace: NAMESPACE }, async (arguments_) => {
				const id = arguments_.path;
				// CSS: serve the raw stylesheet so esbuild extracts it into a CSS
				// asset. Server environments' plugin `load` returns empty for CSS
				// (the content is meant to be emitted by the build + linked via the
				// RSC assets manifest), which would otherwise drop the styles.
				if (id.split('?')[0].endsWith('.css') && fileSystem.exists(id)) {
					return { contents: fileSystem.readFileText(id), loader: 'css', resolveDir: directoryOf(id) };
				}
				const loaded = id.startsWith('/node_modules/') ? undefined : await container.load(id, environment);
				let code = loaded?.code;
				if (code === undefined) {
					if (!fileSystem.exists(id)) {
						return { errors: [{ text: `No loader produced contents for "${id}"` }] };
					}
					code = fileSystem.readFileText(id);
				}
				// Run the plugin transform chain on every module — including vendored
				// node_modules — so plugin-rsc can patch react-server-dom-webpack's
				// `__webpack_require__` loader. Plugin transforms are id/code-filtered,
				// so most skip dependency source.
				let transformed = await container.transform(code, id, environment);
				// Expose the bundled client runtime's React on globals so the
				// dev-served (unbundled) client components re-export the SAME instance
				// (hooks need a single React). Prepended to the client entry only.
				if (environment === 'client' && globalThis.__VINEXT_HOST_DEV__ === true && id === clientEntryId) {
					transformed = { ...transformed, code: CLIENT_REACT_GLOBAL_EXPOSE + transformed.code };
				}
				if (moduleExports !== undefined) {
					// Record each module's export names so the build can populate
					// `chunk.modules[id].renderedExports` — plugin-rsc re-exports exactly
					// those for client references; an empty list yields an undefined
					// component at SSR time.
					moduleExports.set(id, lexExportNames(transformed.code));
				}
				return { contents: transformed.code, loader: loaderForId(id), resolveDir: directoryOf(id) };
			});
		},
	};
}

/**
 * Bundle a module graph for one environment, driving resolution/loading/
 * transformation through the plugin container. Returns a single ESM string.
 */
export async function bundleModuleGraph(options: BundleModuleGraphOptions): Promise<BundleResult> {
	await options.container.buildStart(options.environment);

	const result = await options.esbuild.build({
		entryPoints: [options.entryId],
		bundle: true,
		format: 'esm',
		target: 'es2022',
		platform: platformForEnvironment(options.environment),
		jsx: 'automatic',
		absWorkingDir: '/',
		write: false,
		sourcemap: options.sourcemap ? 'inline' : false,
		define: options.define,
		banner: bannerForEnvironment(options.environment),
		plugins: [createBridgePlugin(options)],
		logLevel: 'silent',
	});

	const output = result.outputFiles?.[0];
	if (output === undefined) {
		throw new Error('vite-host bundle produced no output');
	}
	return { code: output.text };
}

/**
 * Bundle an environment's entry into a (possibly code-split) set of output
 * chunks, returning the esbuild metafile-derived module/import graph so the
 * caller can construct a Rollup-compatible bundle for the output hooks.
 */
interface MetafileOutput {
	inputs: Record<string, unknown>;
	imports: Array<{ path: string }>;
	/** The CSS file esbuild generated for this JS output (if it imports CSS). */
	cssBundle?: string;
}

function stripOutDirectory(outputPath: string): string {
	return outputPath.replace(/^.*\/__out\//, '').replace(/^\/?__out\//, '');
}

/** Remove esbuild's `vite-host:` namespace prefix from a metafile input id. */
function stripModuleNamespace(inputPath: string): string {
	return inputPath.startsWith(`${NAMESPACE}:`) ? inputPath.slice(NAMESPACE.length + 1) : inputPath;
}

/** Extract a module's exported names from its (transformed) source. */
function lexExportNames(code: string): string[] {
	try {
		const exports = lexParse(code)[1];
		return exports.map((entry) => entry.n).filter((name): name is string => name.length > 0);
	} catch {
		return [];
	}
}

/**
 * Find a metafile output entry for `fileName`, tolerating the various key forms
 * esbuild-wasm uses (`/__out/x.js`, `__out/x.js`, …). Matching by filename
 * suffix keeps the chunk's module list — which the RSC plugin's asset-dependency
 * graph keys off — populated.
 */
function findMetafileOutput(
	metafile: { outputs: Record<string, MetafileOutput> } | undefined,
	fileName: string,
): MetafileOutput | undefined {
	if (metafile === undefined) {
		return undefined;
	}
	for (const [key, output] of Object.entries(metafile.outputs)) {
		if (key === fileName || stripOutDirectory(key) === fileName) {
			return output;
		}
	}
	return undefined;
}

export async function bundleEnvironment(options: BundleModuleGraphOptions): Promise<EnvironmentBundle> {
	await options.container.buildStart(options.environment);

	const moduleExports = new Map<string, string[]>();
	const result = await options.esbuild.build({
		entryPoints: [{ in: options.entryId, out: options.entryName ?? 'index' }],
		bundle: true,
		format: 'esm',
		target: 'es2022',
		platform: platformForEnvironment(options.environment),
		jsx: 'automatic',
		absWorkingDir: '/',
		// Code-splitting is disabled: esbuild-wasm exhausts memory splitting the
		// RSC graph in workerd. Client/server reference chunks are handled by the
		// RSC plugin's own emit + the multi-pass build instead.
		splitting: false,
		write: false,
		metafile: true,
		sourcemap: options.sourcemap ? 'inline' : false,
		define: options.define,
		banner: bannerForEnvironment(options.environment),
		entryNames: '[name]',
		chunkNames: 'chunks/[name]-[hash]',
		outdir: '/__out',
		plugins: [createBridgePlugin(options, moduleExports)],
		logLevel: 'silent',
	});

	const metafile = result.metafile;
	const files: BundleOutputFile[] = [];
	// The entry chunk is deterministically the one named after the Rollup input
	// key (`<entryName>.js`); the esbuild metafile output keys are unreliable to
	// match against in workerd, so we key entry detection off the file name.
	const entryFileName = `${options.entryName ?? 'index'}.js`;
	for (const file of result.outputFiles ?? []) {
		const fileName = file.path.replace(/^.*\/__out\//, '').replace(/^\//, '');
		if (fileName.endsWith('.map')) {
			continue;
		}
		const metaEntry = findMetafileOutput(metafile, fileName);
		const cssBundle = metaEntry?.cssBundle === undefined ? undefined : stripOutDirectory(metaEntry.cssBundle);
		files.push({
			fileName,
			text: file.text,
			isEntry: fileName === entryFileName,
			isCss: fileName.endsWith('.css'),
			// Strip esbuild's `<namespace>:` prefix so module ids match the ids the
			// plugin container saw in `transform`/`load` — plugin-rsc keys its
			// client-reference map by those ids when computing each ref's chunk.
			moduleIds: metaEntry ? Object.keys(metaEntry.inputs).map((input) => stripModuleNamespace(input)) : [],
			imports: metaEntry ? metaEntry.imports.map((entry) => stripOutDirectory(entry.path)) : [],
			importedCss: cssBundle === undefined ? [] : [cssBundle],
		});
	}
	return {
		files,
		entryFileName: files.some((file) => file.isEntry) ? entryFileName : (files[0]?.fileName ?? entryFileName),
		moduleExports: Object.fromEntries(moduleExports),
	};
}
