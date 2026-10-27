import { defineConfig, devices } from 'playwright/test';

const testBaseUrl = process.env.TEST_BASE_URL || 'https://localhost:3000';
const testPort = new URL(testBaseUrl).port || '3000';

export default defineConfig({
	testDir: './test/e2e',
	timeout: 120_000,
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 1,
	workers: process.env.CI ? 1 : 4,
	reporter: [['html', { open: 'never' }]],
	use: {
		launchOptions: { timeout: 15_000 },
		baseURL: testBaseUrl,
		ignoreHTTPSErrors: new URL(testBaseUrl).hostname === 'localhost',
		trace: 'on-first-retry',
		screenshot: 'only-on-failure',
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] },
		},
		{ name: 'firefox', use: { ...devices['Desktop Firefox'] } },
		{ name: 'webkit', use: { ...devices['Desktop Safari'] } },
	],
	webServer:
		process.env.CI || process.env.TEST_BASE_URL
			? undefined
			: {
					command: `bun run db:migrate:local && bun run build:worker-types && bunx vite --port ${testPort} --strictPort`,
					url: `${testBaseUrl}/api/templates`,
					reuseExistingServer: false,
					env: { WORKER_IDE_E2E: '1' },
					ignoreHTTPSErrors: new URL(testBaseUrl).hostname === 'localhost',
					timeout: 120_000,
				},
});
