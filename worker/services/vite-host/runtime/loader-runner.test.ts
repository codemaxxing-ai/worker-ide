import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { WORKERS_COMPATIBILITY_DATE } from '@shared/constants';

import { getServerEntrypoint } from './loader-runner';

describe('getServerEntrypoint', () => {
	it('instantiates a module set in a LOADER isolate and serves requests', async () => {
		const entrypoint = getServerEntrypoint({
			loader: env.LOADER,
			cacheKey: 'vite-host-test:trivial:v1',
			moduleSet: {
				compatibilityDate: WORKERS_COMPATIBILITY_DATE,
				mainModule: 'index.js',
				modules: {
					'index.js': `import { greeting } from "./greeting.js";
						export default { fetch() { return new Response(greeting + " from LOADER"); } };`,
					'greeting.js': 'export const greeting = "hello";',
				},
			},
		});
		const response = await entrypoint.fetch('https://example.com/');
		expect(await response.text()).toBe('hello from LOADER');
	});
});
