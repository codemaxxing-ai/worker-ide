/**
 * Integration: the shipped vinext starter template must build and render
 * end-to-end through the in-worker Vite Surface Host — including its client
 * component (`app/counter.tsx`, `"use client"`). This guards against the
 * template drifting from what the build host can actually produce.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { WORKERS_COMPATIBILITY_DATE } from '@shared/constants';

import { routeAppRequest } from './app-runtime';
import { getServerEntrypoint, serverModulesFromOutput } from './loader-runner';
import { getTemplate } from '../../../templates';
import { buildVinext } from '../runtimes/vinext-build';

/**
 * The template's files, re-keyed to the absolute paths the host expects.
 * `buildVinext` strips IDE-managed Cloudflare config (wrangler.jsonc) itself.
 */
function templateSnapshot(): Record<string, string> {
	const template = getTemplate('vinext');
	if (template === undefined) throw new Error('vinext template is not registered');
	return Object.fromEntries(Object.entries(template.files).map(([path, contents]) => [`/${path}`, contents]));
}

describe('vinext starter template', () => {
	it('builds and renders the App Router template with a client component', async () => {
		const build = await buildVinext(templateSnapshot(), { hostDevelopment: false });

		const server = getServerEntrypoint({
			loader: env.LOADER,
			cacheKey: `vinext-template:${Date.now()}`,
			moduleSet: {
				compatibilityDate: WORKERS_COMPATIBILITY_DATE,
				compatibilityFlags: ['nodejs_compat'],
				mainModule: build.mainModule,
				modules: serverModulesFromOutput(build.serverModules),
			},
		});
		const sources = { clientOutput: build.clientOutput, server };

		const response = await routeAppRequest(new Request('https://example.com/'), sources);
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(body).not.toContain('__next_error__');
		// The server page (RSC) renders to HTML.
		expect(body).toContain('<h1>Hello vinext</h1>');
		// The client component is server-rendered into the HTML too.
		expect(body).toContain('Count:');

		// The client bundle is served as a static asset.
		const clientEntry = await routeAppRequest(new Request('https://example.com/index.js'), sources);
		expect(clientEntry.status).toBe(200);
		expect(clientEntry.headers.get('Content-Type')).toBe('application/javascript');
	}, 180_000);
});
