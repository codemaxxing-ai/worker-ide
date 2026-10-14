/**
 * esm.sh fallback for third-party dependencies in the vinext build.
 *
 * The vinext bridge resolves bare imports against the vendored virtual
 * `node_modules` (React + the RSC runtime only). Anything else — a package the
 * user added to `package.json`, e.g. `react-confetti` — has no source to bundle
 * and would otherwise be left as a bare external that fails at load time
 * (`No such module "ssr/<pkg>"`). This module bridges that gap: unresolved,
 * registered dependencies are fetched from the esm.sh CDN at build time and
 * inlined, exactly like the static/SPA pipeline already does.
 *
 * React (and the rest of the RSC runtime) is kept external in the esm.sh URL so
 * a fetched module's `import "react"` re-enters the bridge and resolves to the
 * SAME vendored React the rest of the build uses — a second React instance
 * would break hooks.
 */
import { readWorkerModule } from '@shared/worker-resource-budget';

import { parsePackageSpecifier } from './package-resolver';

import type { MemoryFileSystem } from './node-fs/memory-file-system';

export const ESM_CDN_ORIGIN = 'https://esm.sh';

/** esbuild namespace for modules fetched from esm.sh. */
export const ESM_CDN_NAMESPACE = 'vite-host-esm-cdn';

/**
 * Packages kept external in the esm.sh URL (`?external=`) so fetched modules
 * import them as bare specifiers — which the bridge then resolves to the single
 * vendored React/RSC instance instead of a duplicate esm.sh copy. These are
 * also never themselves fetched from esm.sh (they resolve to the vendored
 * source / runtime).
 */
export const ESM_CDN_EXTERNAL_DEPS = ['react', 'react-dom', 'react-server-dom-webpack'] as const;

/**
 * Packages that must NEVER be fetched from esm.sh, even if they appear in the
 * build graph or `dependencies`:
 * - the React/RSC runtime family (`ESM_CDN_EXTERNAL_DEPS`) — resolved from the
 *   vendored source so there is a single instance;
 * - the Vite/vinext build toolchain — these are node/build-time tools that
 *   vinext's runtime references but that must stay external (their esm.sh builds
 *   pull in unbundleable node-only deps like `vite` -> `@vitejs/devtools` →
 *   `devframe`, which 404 and break the build).
 */
const ESM_CDN_EXCLUDED_PACKAGES: ReadonlySet<string> = new Set([...ESM_CDN_EXTERNAL_DEPS, 'vite', 'vinext']);
const ESM_CDN_EXCLUDED_PREFIXES = ['@vitejs/'] as const;

/** True for a package that must never be CDN-fetched (resolved from vendored source, provided by the runtime, or build-time-only). */
export function isEsmCdnExcluded(packageName: string): boolean {
	if (ESM_CDN_EXCLUDED_PACKAGES.has(packageName)) {
		return true;
	}
	return ESM_CDN_EXCLUDED_PREFIXES.some((prefix) => packageName.startsWith(prefix));
}

/** esm.sh build target — a standardized ES2022 build that runs in both the browser client and the node/workerd server isolates. */
const ESM_CDN_TARGET = 'es2022';

/**
 * Read the project's runtime dependency versions from `/package.json`.
 *
 * ONLY the `dependencies` field is considered — that's where user-added runtime
 * packages live (`dependencies_update` writes there). `devDependencies` is the
 * build-time toolchain (`vinext`, `vite`, `@vitejs/*`, `typescript`, …) which is
 * resolved from the vendored runtime or left external; CDN-fetching it would be
 * wrong (and breaks the build). Returns an empty map if package.json is absent
 * or unparseable.
 */
export function readDependencyVersions(fileSystem: MemoryFileSystem): Map<string, string> {
	const versions = new Map<string, string>();
	if (!fileSystem.exists('/package.json')) {
		return versions;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(fileSystem.readFileText('/package.json'));
	} catch {
		return versions;
	}
	if (typeof parsed !== 'object' || parsed === null || !('dependencies' in parsed)) {
		return versions;
	}
	const dependencies: unknown = Reflect.get(parsed, 'dependencies');
	if (typeof dependencies === 'object' && dependencies !== null) {
		for (const [name, version] of Object.entries(dependencies)) {
			if (typeof version === 'string') {
				versions.set(name, version);
			}
		}
	}
	return versions;
}

/**
 * Build the esm.sh URL for a bare specifier, pinned to `version` when it is a
 * concrete range (not `*`/empty). React-family deps are externalized so they
 * dedupe to the vendored instance.
 */
export function buildEsmCdnUrl(specifier: string, version: string | undefined): string {
	const { packageName, subpath } = parsePackageSpecifier(specifier);
	const pinned = version !== undefined && version !== '' && version !== '*' ? `${packageName}@${version}` : packageName;
	const path = subpath === undefined ? pinned : `${pinned}/${subpath}`;
	const query = `target=${ESM_CDN_TARGET}&external=${ESM_CDN_EXTERNAL_DEPS.join(',')}`;
	return `${ESM_CDN_ORIGIN}/${path}?${query}`;
}

/** Resolve a (possibly relative) import emitted inside an esm.sh module against its esm.sh URL. */
export function resolveEsmCdnImport(importer: string, specifier: string): string {
	try {
		return new URL(specifier, importer).href;
	} catch {
		return specifier;
	}
}

/** Cache API namespace for esm.sh module sources (off-heap, survives isolate recycling within a colo). */
const ESM_CDN_CACHE_NAME = 'vite-host-esm-cdn-v1';

/** The Cloudflare Cache API, when available (absent in some test/non-worker contexts). */
async function openEsmCache(): Promise<Cache | undefined> {
	try {
		return await caches.open(ESM_CDN_CACHE_NAME);
	} catch {
		return undefined;
	}
}

/**
 * Fetch a module's source from esm.sh, following redirects, cached in the
 * Cloudflare Cache API only (off-heap, colo-managed, keyed by the immutable
 * version-pinned URL — no in-isolate state). esm.sh serves pinned versions as
 * immutable, so the Cache API entry never serves stale code for a pinned
 * dependency. The write is awaited so a subsequent request in the same build
 * observes it. Throws a descriptive error on a non-OK response so it surfaces in
 * the build's error overlay.
 */
export async function fetchEsmModule(url: string, fetchImplementation: typeof fetch = fetch): Promise<string> {
	const cache = await openEsmCache();
	const cachedResponse = cache === undefined ? undefined : await cache.match(url).catch(() => {});
	if (cachedResponse !== undefined) {
		return readWorkerModule(cachedResponse);
	}

	const response = await fetchImplementation(url, { redirect: 'follow' });
	if (!response.ok) {
		const detail = response.status === 404 ? 'package or version not found' : `${response.status} ${response.statusText}`;
		throw new Error(`Failed to fetch "${url}" from esm.sh (${detail}).`);
	}
	const source = await readWorkerModule(response);
	// Store off-heap under our own long-lived, immutable Cache-Control so the
	// entry is reused regardless of esm.sh's response headers. Best-effort.
	if (cache !== undefined) {
		const cacheable = new Response(source, {
			headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=604800' },
		});
		await cache.put(url, cacheable).catch(() => {});
	}
	return source;
}
