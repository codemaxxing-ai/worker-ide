/**
 * Integration: the PREVIEW (development) build renders a vinext route to HTML in
 * a LOADER isolate. Preview builds the app bundle and the shared React modules
 * with NODE_ENV=development so vinext/React emit full error messages + stacks
 * (surfaced through the IDE overlay). The patched react-server-dom-webpack (in
 * the app bundle) and the shared dev React must agree on __DEV__ internals —
 * otherwise the RSC render crashes (`dispatcher.getOwner is not a function`).
 * This locks the dev render path.
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

describe('vinext App Router render (development/preview)', () => {
	it('renders a route to HTML with the development React build', async () => {
		const build = await buildVinext(FILES, { hostDevelopment: true });
		const server = getServerEntrypoint({
			loader: env.LOADER,
			cacheKey: `vinext-dev-render:${Date.now()}`,
			moduleSet: {
				compatibilityDate: WORKERS_COMPATIBILITY_DATE,
				compatibilityFlags: ['nodejs_compat'],
				mainModule: build.mainModule,
				modules: serverModulesFromOutput(build.serverModules),
			},
		});
		const response = await routeAppRequest(new Request('https://example.com/'), { clientOutput: build.clientOutput, server });
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(body).toContain('<h1>Hello vinext</h1>');
		expect(body).not.toContain('__next_error__');
	}, 180_000);
});
