import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(dirname, '../');

export default defineConfig({
	plugins: [
		react(),
		storybookTest({
			configDir: path.join(projectRoot, '.storybook'),
			storybookScript: 'bun run storybook --ci',
		}),
	],
	resolve: {
		alias: {
			'@': path.join(projectRoot, 'src'),
			'@shared': path.join(projectRoot, 'shared'),
			'virtual:pwa-register/react': path.join(projectRoot, '.storybook/mock-pwa.ts'),
		},
	},
	define: {
		__APP_VERSION__: '"storybook"',
	},
	optimizeDeps: {
		include: ['react-dom/client', 'better-auth/react', 'better-auth/client/plugins'],
	},
	test: {
		name: 'storybook',
		fileParallelism: false,
		maxWorkers: 1,
		browser: {
			enabled: true,
			headless: true,
			provider: 'playwright',
			instances: [{ browser: 'chromium' }],
		},
		setupFiles: [path.join(projectRoot, '.storybook/vitest.setup.ts')],
	},
});
