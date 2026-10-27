/**
 * Integration: the production deploy build of the vinext starter template must
 * produce a STANDALONE Worker — self-contained server modules (only
 * `nodejs_compat` required) plus client assets with no dev-only artifacts — and
 * render the route to HTML when run with `['nodejs_compat']` alone, exactly as a
 * deployed Worker would.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { WORKERS_COMPATIBILITY_DATE } from '@shared/constants';

import { routeAppRequest } from './app-runtime';
import { getServerEntrypoint, serverModulesFromOutput } from './loader-runner';
import { getTemplate } from '../../../templates';
import { buildVinext } from '../runtimes/vinext-build';

/** Production (deploy) build of the vinext runtime from a project snapshot. */
const buildVinextForDeploy = (snapshot: Record<string, string>) => buildVinext(snapshot, { hostDevelopment: false });

function templateSnapshot(): Record<string, string> {
	const template = getTemplate('vinext');
	if (template === undefined) throw new Error('vinext template is not registered');
	return Object.fromEntries(Object.entries(template.files).map(([path, contents]) => [`/${path}`, contents]));
}

describe('vinext deploy build', () => {
	it('produces a standalone server module set and client assets', async () => {
		const build = await buildVinextForDeploy(templateSnapshot());

		// Server module set: a self-contained module worker keyed by `index.js`.
		expect(build.mainModule).toBe('index.js');
		expect(Object.keys(build.serverModules)).toContain('index.js');
		// React + the RSC runtime are bundled; the only runtime requirement is
		// `nodejs_compat` (the server entry uses `node:module`).
		const serverBlob = JSON.stringify(build.serverModules);
		expect(serverBlob).not.toContain('node:fs');

		// Client assets are standalone: no dev-only client-reference URLs, no
		// React-on-globals, and no `index.html` (the server renders `/`).
		const clientKeys = Object.keys(build.clientOutput);
		expect(clientKeys).toContain('index.js');
		expect(clientKeys).toContain('index.css');
		expect(clientKeys.some((key) => key.includes('@vinext-client'))).toBe(false);
		expect(clientKeys).not.toContain('index.html');
		expect(build.clientOutput['index.js']).not.toContain('__vinext_react');
	}, 180_000);

	it('renders the route with only the nodejs_compat flag', async () => {
		const build = await buildVinextForDeploy(templateSnapshot());
		const server = getServerEntrypoint({
			loader: env.LOADER,
			cacheKey: `vinext-deploy:${Date.now()}`,
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
		expect(body).toContain('Count:');
	}, 180_000);
});
