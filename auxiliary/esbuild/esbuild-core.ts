import * as esbuild from 'esbuild-wasm';

import { BundleDependencyError } from '@shared/bundler-types';
import { toAbsolutePreviewPath } from '@shared/preview-path';
import { WorkerBuildBudget, readWorkerModule } from '@shared/worker-resource-budget';

import esbuildWasm from '../../vendor/esbuild.wasm';

import type { BundleResult, BundleWithCdnOptions, TransformOptions, TransformResult } from '@shared/bundler-types';
import type { DependencyError } from '@shared/types';

let esbuildInitialized = false;
let esbuildInitializePromise: Promise<void> | undefined;

async function initializeEsbuild(): Promise<void> {
	if (esbuildInitialized) return;

	if (esbuildInitializePromise) {
		return esbuildInitializePromise;
	}

	esbuildInitializePromise = (async () => {
		try {
			await esbuild.initialize({
				wasmModule: esbuildWasm,
				worker: false,
			});
			esbuildInitialized = true;
		} catch (error) {
			if (error instanceof Error && error.message.includes('Cannot call "initialize" more than once')) {
				esbuildInitialized = true;
				return;
			}
			esbuildInitializePromise = undefined;
			throw error;
		}
	})();

	return esbuildInitializePromise;
}

function getLoader(path: string): esbuild.Loader {
	if (path.endsWith('.ts') || path.endsWith('.mts')) return 'ts';
	if (path.endsWith('.tsx')) return 'tsx';
	if (path.endsWith('.jsx')) return 'jsx';
	if (path.endsWith('.json')) return 'json';
	if (path.endsWith('.css')) return 'css';
	return 'js';
}
export async function transformCode(code: string, filename: string, options?: TransformOptions): Promise<TransformResult> {
	new WorkerBuildBudget().addSource(code);
	await initializeEsbuild();

	const loader = getLoader(filename);

	const result = await esbuild.transform(code, {
		loader,
		sourcefile: filename,
		sourcemap: options?.sourcemap ? 'inline' : false,
		format: 'esm',
		target: 'es2022',
		tsconfigRaw: options?.tsconfigRaw,
	});

	return {
		code: result.code,
		map: result.map || undefined,
	};
}

const ESM_CDN = 'https://esm.sh';
function extractPackageName(urlPath: string): string {
	const parts = urlPath.split('/');
	const scopedName = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
	// Strip version suffix (e.g. "react@19.0.0" → "react")
	const atIndex = scopedName.startsWith('@') ? scopedName.indexOf('@', 1) : scopedName.indexOf('@');
	return atIndex > 0 ? scopedName.slice(0, atIndex) : scopedName;
}

/**
 * Fetch a module from esm.sh, following redirects.
 * Pushes structured errors into the collector when a package cannot be resolved.
 */
async function fetchFromCdn(url: string, dependencyErrors?: DependencyError[], budget?: WorkerBuildBudget): Promise<string> {
	const response = await fetch(url, { redirect: 'follow' });
	if (!response.ok) {
		const urlPath = url.replace(ESM_CDN + '/', '');
		const packageName = extractPackageName(urlPath);
		if (response.status === 404) {
			const message = `Package not found: "${packageName}". Check that the package name and version are correct.`;
			dependencyErrors?.push({ packageName, code: 'not-found', message });
			throw new Error(message);
		}
		const message = `Failed to resolve "${packageName}" from CDN (${response.status} ${response.statusText}). The package or version may be invalid.`;
		dependencyErrors?.push({ packageName, code: 'resolve-failed', message });
		throw new Error(message);
	}
	return readWorkerModule(response, budget);
}
function resolveUrl(base: string, relative: string): string {
	try {
		return new URL(relative, base).href;
	} catch {
		return relative;
	}
}

/**
 * esbuild plugin that resolves bare package imports via esm.sh CDN.
 * Fetches and inlines the module source at bundle time.
 */
function createEsmCdnPlugin(dependencyErrors: DependencyError[], budget: WorkerBuildBudget): esbuild.Plugin {
	return {
		name: 'esm-cdn',
		setup(build) {
			// Resolve bare specifiers to esm.sh URLs
			build.onResolve({ filter: /.*/, namespace: 'esm-cdn' }, (arguments_) => {
				// Relative imports within esm.sh modules
				if (arguments_.path.startsWith('.') || arguments_.path.startsWith('/')) {
					return {
						path: resolveUrl(arguments_.importer, arguments_.path),
						namespace: 'esm-cdn',
					};
				}
				// Bare specifiers within esm.sh (transitive deps)
				return {
					path: `${ESM_CDN}/${arguments_.path}`,
					namespace: 'esm-cdn',
				};
			});

			// Load modules from esm.sh
			build.onLoad({ filter: /.*/, namespace: 'esm-cdn' }, async (arguments_) => {
				const source = await fetchFromCdn(arguments_.path, dependencyErrors, budget);
				return { contents: source, loader: 'js' };
			});
		},
	};
}

function resolveRelativePath(resolveDirectory: string, relativePath: string, files: Record<string, string>): string | undefined {
	const directory = resolveDirectory.replace(/^\//, '');
	const parts = directory ? directory.split('/') : [];
	const relativeParts = relativePath.split('/');

	for (const part of relativeParts) {
		if (part === '..') {
			parts.pop();
		} else if (part !== '.') {
			parts.push(part);
		}
	}

	const resolved = parts.join('/');

	if (resolved in files) {
		return resolved;
	}

	const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs'];
	for (const extension of extensions) {
		if (resolved + extension in files) {
			return resolved + extension;
		}
	}

	for (const extension of extensions) {
		const indexPath = `${resolved}/index${extension}`;
		if (indexPath in files) {
			return indexPath;
		}
	}

	return undefined;
}

/**
 * Create a virtual-fs esbuild plugin for bundling files from a Record.
 * When `resolveBareFromCdn` is true, bare specifiers are sent to the esm-cdn namespace
 * instead of being marked as external.
 * When `reactRefresh` is true, JS/TS modules get React Fast Refresh registration wrappers.
 */
function createVirtualFsPlugin(
	files: Record<string, string>,
	externals: string[],
	resolveBareFromCdn: boolean,
	knownDependencies?: Map<string, string>,
	dependencyErrors?: DependencyError[],
	resolvedDependencies?: Set<string>,
	reactRefresh?: boolean,
): esbuild.Plugin {
	return {
		name: 'virtual-fs',
		setup(build) {
			// Only handle imports from the virtual namespace or entry points.
			// Imports from esm-cdn namespace are handled by the esm-cdn plugin.
			build.onResolve({ filter: /.*/ }, (arguments_) => {
				// Let the esm-cdn plugin handle its own namespace
				if (arguments_.namespace === 'esm-cdn') return;

				if (arguments_.kind === 'entry-point') {
					return { path: arguments_.path, namespace: 'virtual' };
				}

				if (arguments_.path.startsWith('.')) {
					const resolved = resolveRelativePath(arguments_.resolveDir, arguments_.path, files);
					if (resolved) {
						return { path: resolved, namespace: 'virtual' };
					}
					// esbuild may absolutize the resolveDir returned by onLoad,
					// breaking the lookup against virtual filesystem keys. Fall
					// back to deriving the directory from the importer path
					// (which is always a relative virtual-fs key like "src/main.ts").
					if (arguments_.importer) {
						const lastSlash = arguments_.importer.lastIndexOf('/');
						const importerDirectory = lastSlash === -1 ? '' : arguments_.importer.slice(0, lastSlash);
						const resolvedFromImporter = resolveRelativePath(importerDirectory, arguments_.path, files);
						if (resolvedFromImporter) {
							return { path: resolvedFromImporter, namespace: 'virtual' };
						}
					}
					// When the import originates from the virtual namespace (our
					// controlled resolveDir), a failed resolve means the file is
					// genuinely missing. Return a build error so it surfaces in the
					// error overlay instead of being silently marked external
					// (which causes a blank 404 in the browser).
					if (arguments_.namespace === 'virtual') {
						return {
							errors: [{ text: `Could not resolve "${arguments_.path}" — the file does not exist in the project` }],
						};
					}
				}

				if (!arguments_.path.startsWith('/') && !arguments_.path.startsWith('.')) {
					if (externals.includes(arguments_.path) || externals.some((error) => arguments_.path.startsWith(`${error}/`))) {
						return { path: arguments_.path, external: true };
					}
					if (resolveBareFromCdn) {
						const parts = arguments_.path.split('/');
						const packageName = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
						const subpath = parts[0].startsWith('@') ? parts.slice(2).join('/') : parts.slice(1).join('/');

						// Only resolve imports that are registered as dependencies
						if (knownDependencies) {
							const version = knownDependencies.get(packageName);
							if (version === undefined) {
								const errorMessage = `Unregistered dependency "${packageName}". Add it to project dependencies using the Dependencies panel.`;
								dependencyErrors?.push({ packageName, code: 'unregistered', message: errorMessage });
								return {
									errors: [{ text: errorMessage }],
								};
							}
							// Track that this dependency was actually used during bundling
							resolvedDependencies?.add(packageName);
							// Use the registered version in the esm.sh URL
							const versionedPackage = version && version !== '*' ? `${packageName}@${version}` : packageName;
							const cdnPath = subpath ? `${versionedPackage}/${subpath}` : versionedPackage;
							return {
								path: `${ESM_CDN}/${cdnPath}`,
								namespace: 'esm-cdn',
							};
						}

						// No dependency list provided — resolve all bare imports via CDN
						return {
							path: `${ESM_CDN}/${arguments_.path}`,
							namespace: 'esm-cdn',
						};
					}
					return { path: arguments_.path, external: true };
				}

				const normalizedPath = arguments_.path.startsWith('/') ? arguments_.path.slice(1) : arguments_.path;
				if (normalizedPath in files) {
					return { path: normalizedPath, namespace: 'virtual' };
				}

				return { path: arguments_.path, external: true };
			});

			build.onLoad({ filter: /.*/, namespace: 'virtual' }, (arguments_) => {
				const content = files[arguments_.path];
				if (content === undefined) {
					return { errors: [{ text: `File not found: ${arguments_.path}` }] };
				}

				// Convert CSS imports to JS that injects/replaces a <style> tag.
				// Uses replaceChild pattern so HMR re-evaluation updates existing
				// styles in-place rather than appending duplicate <style> tags.
				if (arguments_.path.endsWith('.css')) {
					const cssContent = JSON.stringify(content);
					const developmentId = JSON.stringify(toAbsolutePreviewPath(arguments_.path));
					const jsCode = [
						`const css = ${cssContent};`,
						`var existing = document.querySelector('style[data-dev-id=' + JSON.stringify(${developmentId}) + ']');`,
						`if (existing) {`,
						`  existing.textContent = css;`,
						`} else {`,
						`  var style = document.createElement('style');`,
						`  style.setAttribute('data-dev-id', ${developmentId});`,
						`  style.textContent = css;`,
						`  document.head.appendChild(style);`,
						`}`,
						`export default css;`,
					].join('\n');
					return { contents: jsCode, loader: 'js' };
				}

				let moduleContent = content;

				// For browser-targeted builds with React Refresh enabled,
				// wrap JS/TS/JSX/TSX modules with Fast Refresh registration calls.
				// This injects $RefreshReg$ calls for each detected React component,
				// enabling state-preserving hot updates.
				if (reactRefresh && isJsxOrTsxFile(arguments_.path)) {
					moduleContent = wrapModuleWithRefreshRegistrations(content, arguments_.path);
				}

				const loader = getLoader(arguments_.path);
				const lastSlash = arguments_.path.lastIndexOf('/');
				const resolveDirectory = lastSlash === -1 ? '' : arguments_.path.slice(0, lastSlash);
				return { contents: moduleContent, loader, resolveDir: resolveDirectory };
			});
		},
	};
}

/**
 * Regex to detect React component declarations in esbuild-transformed output.
 *
 * Matches patterns like:
 *   function App(           — named function declaration
 *   const App =             — const/let/var assignment (arrow or function expression)
 *   var App = function(     — var assignment with function expression
 *
 * Only matches names starting with an uppercase letter (React component convention).
 * Handles the `export` keyword prefix.
 *
 * NOTE: This runs on the esbuild-transformed output (JSX already compiled),
 * not on raw user source code.
 */
const COMPONENT_DECLARATION_REGEX =
	/(?:^|[\n;])\s*(?:export\s+(?:default\s+)?)?(?:function\s+([A-Z][A-Za-z0-9_$]*)\s*\(|(?:const|let|var)\s+([A-Z][A-Za-z0-9_$]*)\s*=)/g;

/**
 * Detect likely React component names in esbuild-transformed code.
 * Returns an array of component names found.
 */
function detectComponentNames(code: string): string[] {
	const names = new Set<string>();
	let match: RegExpExecArray | null;
	COMPONENT_DECLARATION_REGEX.lastIndex = 0;
	while ((match = COMPONENT_DECLARATION_REGEX.exec(code)) !== null) {
		const name = match[1] || match[2];
		if (name) {
			names.add(name);
		}
	}
	return [...names];
}

/**
 * Wrap a module's code with React Fast Refresh registration calls.
 *
 * This sets `$RefreshReg$` to a file-scoped registrar during module evaluation,
 * then restores the previous value after. The detected component names get
 * explicitly registered at the end.
 *
 * This approach works WITHOUT Babel — we detect components by name pattern
 * after esbuild has already transformed JSX. The tradeoff is that we don't
 * get hook signature tracking (hooks changes cause full remount, not
 * state-preserving re-render). This is acceptable because:
 * 1. Most edits are to JSX/render logic, not hook structure
 * 2. Hook order changes are rare and full remount is the safe behavior
 */
function wrapModuleWithRefreshRegistrations(code: string, filePath: string): string {
	const componentNames = detectComponentNames(code);
	if (componentNames.length === 0) {
		return code;
	}

	const fileId = JSON.stringify(filePath);
	const registrations = componentNames.map((name) => `  $RefreshReg$(${name}, ${JSON.stringify(name)});`).join('\n');

	// Wrap in an IIFE-like structure using esbuild's module scope.
	// We save/restore the global $RefreshReg$ so nested modules each get
	// their own file-scoped registrar.
	return [
		`var __prevRefreshReg = window.$RefreshReg$;`,
		`var __prevRefreshSig = window.$RefreshSig$;`,
		`window.$RefreshReg$ = function(type, id) {`,
		`  window.__RefreshRuntime && window.__RefreshRuntime.register(type, ${fileId} + " " + id);`,
		`};`,
		`window.$RefreshSig$ = window.__RefreshRuntime ? window.__RefreshRuntime.createSignatureFunctionForTransform : function() { return function(type) { return type; }; };`,
		code,
		`if (window.__RefreshRuntime) {`,
		registrations,
		`}`,
		`window.$RefreshReg$ = __prevRefreshReg;`,
		`window.$RefreshSig$ = __prevRefreshSig;`,
	].join('\n');
}
function isJsxOrTsxFile(filePath: string): boolean {
	return /\.(tsx|jsx|ts|js|mts|mjs)$/.test(filePath);
}

/**
 * Bundle files into a single JavaScript module, resolving bare package imports
 * from esm.sh CDN at bundle time. Used for both frontend (React) and backend (Hono).
 */
export async function bundleWithCdn(options: BundleWithCdnOptions): Promise<BundleResult> {
	const budget = new WorkerBuildBudget();
	for (const contents of Object.values(options.files)) budget.addSource(contents);
	await initializeEsbuild();

	const {
		files,
		entryPoint,
		externals = [],
		minify = false,
		sourcemap = false,
		tsconfigRaw,
		platform = 'browser',
		knownDependencies,
		reactRefresh = false,
	} = options;

	const collectedDependencyErrors: DependencyError[] = [];
	const resolvedDependencies = new Set<string>();
	const virtualFsPlugin = createVirtualFsPlugin(
		files,
		externals,
		true,
		knownDependencies,
		collectedDependencyErrors,
		resolvedDependencies,
		reactRefresh,
	);

	let result: esbuild.BuildResult;
	try {
		result = await esbuild.build({
			entryPoints: [entryPoint],
			bundle: true,
			write: false,
			format: 'esm',
			platform,
			target: 'es2022',
			minify,
			sourcemap: sourcemap ? 'inline' : false,
			plugins: [virtualFsPlugin, createEsmCdnPlugin(collectedDependencyErrors, budget)],
			outfile: 'bundle.js',
			tsconfigRaw,
		});
	} catch (error) {
		// Re-throw with collected dependency errors attached so the caller can use them
		if (collectedDependencyErrors.length > 0) {
			// Safe to assert non-undefined: we checked length > 0
			throw new BundleDependencyError(error, deduplicateDependencyErrors(collectedDependencyErrors)!);
		}
		throw error;
	}

	const output = result.outputFiles?.[0];
	if (!output) {
		throw new Error('No output generated from esbuild');
	}

	let code = output.text;

	// When React Fast Refresh is enabled, append a postamble that triggers
	// the refresh after all modules have executed and registered their components.
	// The debounce ensures that if multiple modules register in the same tick,
	// we only trigger one refresh pass.
	if (reactRefresh) {
		code += `\n;if(window.__RefreshRuntime){window.__RefreshRuntime.performReactRefresh();}`;
	}

	return {
		code,
		warnings: result.warnings.map((w) => w.text),
		dependencyErrors: deduplicateDependencyErrors(collectedDependencyErrors),
	};
}
function deduplicateDependencyErrors(errors: DependencyError[]): DependencyError[] | undefined {
	if (errors.length === 0) return undefined;
	const seen = new Set<string>();
	return errors.filter((error) => {
		if (seen.has(error.packageName)) return false;
		seen.add(error.packageName);
		return true;
	});
}
