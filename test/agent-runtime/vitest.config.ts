import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/agent-runtime/**/*.test.ts'],
		environment: 'node',
		fileParallelism: false,
		testTimeout: 15_000,
		hookTimeout: 30_000,
	},
});
