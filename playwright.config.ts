import { defineConfig, devices } from 'playwright/test';

const testBaseUrl = process.env.TEST_BASE_URL || 'http://localhost:3000';
const testPort = new URL(testBaseUrl).port || '3000';

export default defineConfig({
	testDir: './test/e2e',
	timeout: 120_000,
	globalSetup: './test/e2e/global-setup.ts',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 1,
	workers: process.env.CI ? 1 : 4,
	reporter: [['html', { open: 'never' }]],
	use: {
		baseURL: testBaseUrl,
		trace: 'on-first-retry',
		screenshot: 'only-on-failure',
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] },
		},
	],
	webServer: process.env.CI
		? undefined
		: {
				command: `bun run db:migrate:local && bun run build:worker-types && bunx vite --port ${testPort} --strictPort`,
				url: testBaseUrl,
				reuseExistingServer: false,
				timeout: 120_000,
			},
});
