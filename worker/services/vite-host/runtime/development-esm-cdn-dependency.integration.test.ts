/**
 * Integration: the dev module server (client HMR path) resolves a user-added
 * dependency that is NOT in the vendored node_modules by fetching it from
 * esm.sh, exactly like the SSR build bridge. This is what lets a `"use client"`
 * component `import` a package the user added to `package.json` (e.g. `is-even`)
 * — without it, `/@vinext-client-dep/<pkg>` returns nothing, the request falls
 * through to the app route, and the browser gets HTML for a JS module, crashing
 * the preview with a blank "This page couldn't load".
 *
 * The esm.sh fetch is stubbed so the test is hermetic (no network).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { serveDevelopmentModule } from './development-module-server';
import { ensureEsbuild } from '../esbuild-runtime';
import { buildEsmCdnUrl } from '../esm-cdn';
import { MemoryFileSystem } from '../node-fs/memory-file-system';

const IS_EVEN_MARKER = 'is_even_marker_a91f2';

// Stand-in for what esm.sh serves for `is-even`: a self-contained ESM module
// (esm.sh bundles a package's own transitive deps), free of browser globals.
const FAKE_IS_EVEN_MODULE = `export const IS_EVEN_MARKER = ${JSON.stringify(IS_EVEN_MARKER)};
export default function isEven(n) { return n % 2 === 0; }
`;

const PACKAGE_JSON = JSON.stringify({
	name: 'demo',
	type: 'module',
	dependencies: { 'is-even': '1.0.0' },
});

describe('dev module server esm.sh dependency fallback', () => {
	beforeEach(async () => {
		// Storage isolation is disabled for SQLite workspace tests. Reset this
		// suite's cache entry so each cache-hit assertion has a known baseline.
		const sourceCache = await caches.open('vite-host-esm-cdn-v1');
		await sourceCache.delete(buildEsmCdnUrl('is-even', '1.0.0'));
		const cache = await caches.open('vinext-dev-dep-bundle-v1');
		await cache.delete(`https://vinext-dev-dep.internal/esm/${encodeURIComponent(buildEsmCdnUrl('is-even', '1.0.0'))}`);
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes('esm.sh') && url.includes('is-even')) {
					return new Response(FAKE_IS_EVEN_MODULE, { status: 200, headers: { 'content-type': 'application/javascript' } });
				}
				return new Response('not found', { status: 404, statusText: 'Not Found' });
			}),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('fetches a registered client dependency from esm.sh and serves it as browser ESM', async () => {
		const esbuild = await ensureEsbuild();
		const fileSystem = MemoryFileSystem.fromSnapshot({ '/package.json': PACKAGE_JSON });

		const module = await serveDevelopmentModule(`/@vinext-client-dep/${encodeURIComponent('is-even')}`, { esbuild, fileSystem });

		expect(module).toBeDefined();
		expect(module?.contentType).toBe('application/javascript');
		// The dependency's source was inlined (proves esm.sh fetch + bundle).
		expect(module?.code).toContain(IS_EVEN_MARKER);

		const fetchedUrls = vi.mocked(globalThis.fetch).mock.calls.map((call) => String(call[0]));
		expect(fetchedUrls.some((url) => url.includes('esm.sh') && url.includes('is-even'))).toBe(true);
	}, 120_000);

	it('serves a second request for the same dependency from the Cache API without re-fetching', async () => {
		const esbuild = await ensureEsbuild();
		const fileSystem = MemoryFileSystem.fromSnapshot({ '/package.json': PACKAGE_JSON });
		const path = `/@vinext-client-dep/${encodeURIComponent('is-even')}`;

		const first = await serveDevelopmentModule(path, { esbuild, fileSystem });
		expect(first?.code).toContain(IS_EVEN_MARKER);
		const fetchCallsAfterFirst = vi.mocked(globalThis.fetch).mock.calls.length;
		expect(fetchCallsAfterFirst).toBeGreaterThan(0);

		const second = await serveDevelopmentModule(path, { esbuild, fileSystem });
		expect(second?.code).toBe(first?.code);
		// The bundle came from the Cache API: no additional esm.sh fetch.
		expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(fetchCallsAfterFirst);
	}, 120_000);

	it('returns undefined for an unregistered dependency (not in package.json)', async () => {
		const esbuild = await ensureEsbuild();
		const fileSystem = MemoryFileSystem.fromSnapshot({ '/package.json': PACKAGE_JSON });

		const module = await serveDevelopmentModule(`/@vinext-client-dep/${encodeURIComponent('left-pad')}`, { esbuild, fileSystem });

		expect(module).toBeUndefined();
	}, 120_000);
});
