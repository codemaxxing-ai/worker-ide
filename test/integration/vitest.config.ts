import path from 'node:path';

import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for integration tests.
 *
 * These tests run against a live server instance (local or remote).
 *
 * Environment Variables:
 * - TEST_BASE_URL: Target server URL (default: http://localhost:3000)
 */
export default defineConfig(({ mode }) => {
	const environment = loadEnv(mode, process.cwd(), '');
	return {
		test: {
			include: ['test/integration/**/*.test.ts'],
			globals: true,
			testTimeout: 120_000,
			hookTimeout: 120_000,
			pool: 'threads',
			poolOptions: {
				threads: {
					singleThread: true,
				},
			},
			reporters: ['default'],
			env: {
				TEST_BASE_URL: environment.TEST_BASE_URL || 'http://localhost:3000',
			},
		},
		resolve: {
			alias: {
				'@': path.resolve(import.meta.dirname!, '../../src'),
				'@shared': path.resolve(import.meta.dirname!, '../../shared'),
			},
		},
	};
});
