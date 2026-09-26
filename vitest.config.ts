import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Wrangler validates the asset directory even though these tests exercise
// Worker APIs. A clean checkout should not need a production build first.
mkdirSync(path.resolve(__dirname, 'dist/client'), { recursive: true });

const sharedAlias = {
	'@': path.resolve(__dirname, './src'),
	'@shared': path.resolve(__dirname, './shared'),
	'@server': path.resolve(__dirname, './worker'),
	'@worker': path.resolve(__dirname, './worker'),
};

export default defineConfig({
	resolve: {
		alias: sharedAlias,
	},
	test: {
		projects: [
			// Unit tests - shared utilities, store, pure logic (Node environment)
			{
				test: {
					name: 'unit',
					include: ['shared/**/*.test.ts', 'src/lib/**/*.test.ts', 'auxiliary/**/*.test.ts'],
					environment: 'node',
				},
				resolve: {
					alias: sharedAlias,
				},
			},
			// Worker tests - run inside workerd via @cloudflare/vitest-pool-workers
			defineWorkersProject({
				test: {
					name: 'worker',
					include: ['worker/**/*.test.ts'],
					exclude: ['worker/fixtures/**'],
					// Pre-bundle CJS-only dependencies so workerd's ESM runtime can resolve
					// their named exports. See: https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#module-resolution
					deps: {
						optimizer: {
							ssr: {
								enabled: true,
								// Pre-bundle `ai` together with the Agents SDK packages that
								// re-import its named exports (e.g. `asSchema`). Without this,
								// workerd's ESM runtime fails to resolve those re-exports when
								// loading `@cloudflare/codemode` from the worker entry.
								include: ['ai', '@cloudflare/codemode', '@cloudflare/think', 'agents'],
							},
						},
					},
					poolOptions: {
						workers: {
							// Bindings flagged `remote: true` in wrangler.jsonc (AI, ARTIFACTS,
							// BROWSER) are stubbed/mocked in tests, so we don't need a remote
							// proxy session. Disabling it also avoids the non-interactive
							// "more than one account available" failure.
							remoteBindings: false,
							miniflare: {
								// Auxiliary workers (biome, esbuild) are not available in the
								// test pool. Override their bindings with stubs so miniflare can start.
								serviceBindings: {
									BIOME: () => new Response('service unavailable', { status: 503 }),
									ESBUILD: () => new Response('service unavailable', { status: 503 }),
									VITE_HOST: () => new Response('service unavailable', { status: 503 }),
									PUSH: () => new Response('service unavailable', { status: 503 }),
									EMAIL: () => new Response('service unavailable', { status: 503 }),
									AI: () => new Response('service unavailable', { status: 503 }),
								},
								// ProjectCoordinatorV2 is an internal DO (accessed via `exports` at
								// runtime) but needs an explicit binding here so tests can access
								// it through `env` from `cloudflare:test`.
								durableObjects: {
									AgentRunner: 'AgentRunner',
									ProjectCoordinatorV2: 'ProjectCoordinatorV2',
									SubAgentWorker: 'SubAgentWorker',
									DurableObjectFilesystem: 'DurableObjectFilesystem',
								},
							},
							wrangler: {
								configPath: './wrangler.jsonc',
							},
						},
					},
				},
				resolve: {
					alias: sharedAlias,
				},
			}),
			// React component tests - hooks, components
			{
				define: {
					__APP_VERSION__: JSON.stringify('test-version'),
				},
				test: {
					name: 'react',
					include: ['src/**/*.test.tsx', 'src/features/**/*.test.ts', 'src/hooks/**/*.test.ts'],
					exclude: ['src/lib/**/*.test.ts'],
					environment: 'jsdom',
					setupFiles: ['./src/test-setup.ts'],
				},
				resolve: {
					alias: sharedAlias,
				},
			},
		],
	},
});
