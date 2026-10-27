/**
 * Integration: a server-side render error in a vinext app surfaces as a
 * detectable HTTP 500 `__next_error__` page (NOT a thrown error). The preview
 * preview adapter (`serveVinextPreview`) relies on exactly this
 * signal — status 500 + the `id="__next_error__"` marker — to route the failure
 * through the IDE error overlay instead of letting the silent framework error
 * page reach the iframe. This locks that contract.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { WORKERS_COMPATIBILITY_DATE } from '@shared/constants';

import { routeAppRequest } from './app-runtime';
import { getServerEntrypoint, serverModulesFromOutput } from './loader-runner';
import { buildVinext } from '../runtimes/vinext-build';

const FILES = {
	'/app/page.tsx': 'export default function Page() { throw new Error("render boom"); }',
	'/app/layout.tsx':
		'export default function RootLayout({ children }: { children: React.ReactNode }) { return (<html><body>{children}</body></html>); }',
};

describe('vinext server render error', () => {
	it('returns a detectable 500 __next_error__ page rather than throwing', async () => {
		const build = await buildVinext(FILES, { hostDevelopment: true });
		const server = getServerEntrypoint({
			loader: env.LOADER,
			cacheKey: `vinext-render-error:${Date.now()}`,
			moduleSet: {
				compatibilityDate: WORKERS_COMPATIBILITY_DATE,
				compatibilityFlags: ['nodejs_compat'],
				mainModule: build.mainModule,
				modules: serverModulesFromOutput(build.serverModules),
			},
		});
		const response = await routeAppRequest(new Request('https://example.com/'), { clientOutput: build.clientOutput, server });
		const body = await response.text();

		expect(response.status).toBe(500);
		expect(body).toContain('id="__next_error__"');
	}, 180_000);
});
