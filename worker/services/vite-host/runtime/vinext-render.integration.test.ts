/**
 * Integration: render a vinext App Router route end-to-end in workerd.
 *
 * Builds the full app (rsc worker + ssr) with React resolved from vendored
 * source via per-environment conditions, runs the worker module set in a LOADER
 * isolate, and asserts the route renders to HTML.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { WORKERS_COMPATIBILITY_DATE } from '@shared/constants';

import { routeAppRequest } from './app-runtime';
import { getServerEntrypoint, serverModulesFromOutput } from './loader-runner';
import { buildVinext } from '../runtimes/vinext-build';

const FILES = {
	'/app/page.tsx': 'export default function Page() { return <h1>Hello vinext</h1>; }',
	'/app/layout.tsx':
		'export default function RootLayout({ children }: { children: React.ReactNode }) { return (<html><body>{children}</body></html>); }',
	'/package.json': JSON.stringify({ name: 'demo', type: 'module' }),
};

describe('vinext App Router render', () => {
	it('renders a route to HTML in a LOADER isolate', async () => {
		const build = await buildVinext(FILES, { hostDevelopment: false });

		expect(build.serverModules['index.js']).toBeDefined();
		expect(build.serverModules['ssr/index.js']).toBeDefined();

		const entrypoint = getServerEntrypoint({
			loader: env.LOADER,
			cacheKey: `vinext-render:${Date.now()}`,
			moduleSet: {
				compatibilityDate: WORKERS_COMPATIBILITY_DATE,
				compatibilityFlags: ['nodejs_compat'],
				mainModule: build.mainModule,
				modules: serverModulesFromOutput(build.serverModules),
			},
		});

		const sources = { clientOutput: build.clientOutput, server: entrypoint };

		const response = await routeAppRequest(new Request('https://example.com/'), sources);
		const body = await response.text();

		// End-to-end: the built worker runs in a LOADER isolate and server-renders
		// a full HTML document. Client components resolve via the client-reference
		// module map, so the route's markup (the `<h1>`) is present in the SSR HTML
		// — not just streamed as an RSC payload.
		expect(response.status).toBe(200);
		expect(body.startsWith('<!DOCTYPE html>')).toBe(true);
		expect(body).toContain('<h1>Hello vinext</h1>');
		expect(body).not.toContain('__next_error__');
		expect(body).toContain('vinext.navigationRuntime');

		// The HTML references the client entry at `/index.js`; the router serves it
		// from the client build output instead of delegating to the server isolate.
		const clientEntry = await routeAppRequest(new Request('https://example.com/index.js'), sources);
		expect(clientEntry.status).toBe(200);
		expect(clientEntry.headers.get('Content-Type')).toBe('application/javascript');
		const clientEntryText = await clientEntry.text();
		expect(clientEntryText.length).toBeGreaterThan(0);
	}, 180_000);
});
