import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { parse } from 'jsonc-parser';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const vitestRequire = createRequire(import.meta.resolve('vitest'));

// Wrangler validates the asset directory even though these tests exercise
// Worker APIs. A clean checkout should not need a production build first.
mkdirSync(path.resolve(__dirname, 'dist/client'), { recursive: true });

// Ordinary Worker tests use runtime doubles and never start Docker. Keep
// container images and queue consumers out of the test configuration while
// retaining the application bindings.
const workerTestConfiguration = parse(readFileSync(path.resolve(__dirname, 'wrangler.jsonc'), 'utf8'));
workerTestConfiguration.containers = [];
workerTestConfiguration.queues.consumers = [];
writeFileSync(path.resolve(__dirname, '.wrangler-tests.json'), JSON.stringify(workerTestConfiguration));

const sharedAlias = {
	'@': path.resolve(__dirname, './src'),
	'@shared': path.resolve(__dirname, './shared'),
	'@server': path.resolve(__dirname, './worker'),
	'@worker': path.resolve(__dirname, './worker'),
};

export default defineConfig({
	resolve: {
		alias: [
			...Object.entries(sharedAlias).map(([find, replacement]) => ({ find, replacement })),
			// Storybook also ships Vitest 3 helpers; use the installed runner's versions.
			{
				find: /^@vitest\//,
				replacement: '@vitest/',
				customResolver: (source) => vitestRequire.resolve(source),
			},
		],
	},
	test: {
		projects: [
			// Unit tests - shared utilities, store, pure logic (Node environment)
			{
				test: {
					name: 'unit',
					include: ['shared/**/*.test.ts', 'src/lib/**/*.test.ts', 'auxiliary/**/*.test.ts', 'test/*.test.ts'],
					environment: 'node',
				},
				resolve: {
					alias: sharedAlias,
				},
			},
			// Worker tests run inside workerd through the Cloudflare Vitest plugin.
			{
				test: {
					name: 'worker',
					include: ['worker/**/*.test.ts'],
					exclude: ['worker/fixtures/**'],
					// Durable Object startup and vinext setup can exceed Vitest’s 5s default.
					testTimeout: 15_000,
				},
				plugins: [
					cloudflareTest({
						remoteBindings: false,
						miniflare: {
							serviceBindings: {
								BIOME: () => new Response('service unavailable', { status: 503 }),
								ESBUILD: () => new Response('service unavailable', { status: 503 }),
								VITE_HOST: () => new Response('service unavailable', { status: 503 }),
								PUSH: () => new Response('service unavailable', { status: 503 }),
								EMAIL: () => new Response('service unavailable', { status: 503 }),
								AI: () => new Response('service unavailable', { status: 503 }),
							},
							// Internal Durable Objects need explicit bindings for tests.
							durableObjects: {
								AgentRunner: { className: 'AgentRunner', useSQLite: true },
								ProjectCoordinatorV2: { className: 'ProjectCoordinatorV2', useSQLite: true },
								SubAgentWorker: { className: 'SubAgentWorker', useSQLite: true },
								DurableObjectFilesystem: { className: 'DurableObjectFilesystem', useSQLite: true },
							},
						},
						wrangler: { configPath: './.wrangler-tests.json' },
					}),
				],
				resolve: {
					alias: [
						...Object.entries(sharedAlias).map(([find, replacement]) => ({ find, replacement })),
						// Storybook also ships Vitest 3 helpers; the Worker must use its runner's versions.
						{
							find: /^@vitest\//,
							replacement: '@vitest/',
							customResolver: (source) => vitestRequire.resolve(source),
						},
					],
				},
			},
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
					// Let jsdom provide Storage instead of Node's file-backed Web Storage globals.
					execArgv: ['--no-experimental-webstorage'],
					setupFiles: ['./src/test-setup.ts'],
				},
				resolve: { alias: sharedAlias },
			},
		],
	},
});
