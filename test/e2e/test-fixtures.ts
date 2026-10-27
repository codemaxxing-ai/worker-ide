import { test as baseTest } from 'playwright/test';

import { serveBuiltEditor } from './built-editor';
import { cleanupProjects, gotoIDE } from './helpers';
import { browserLaunchOptions } from '../browser-launch';

import type { IDEOptions } from './helpers';

export { expect } from 'playwright/test';

export const test = baseTest.extend<{ builtEditor: void; nativeProject: string; nativeProjectOptions: IDEOptions }>({
	nativeProjectOptions: [{}, { option: true }],
	nativeProject: [
		async ({ page, nativeProjectOptions }, use) => {
			await use(await gotoIDE(page, nativeProjectOptions));
		},
		// Native commands have a five-minute deadline. Keep cold dependency setup
		// out of the two-minute browser assertion budget, with room for startup.
		{ timeout: 360_000 },
	],
	launchOptions: [
		async ({ browserName, launchOptions }, use) => {
			await using launch = await browserLaunchOptions(browserName, launchOptions);
			await use(launch.options);
		},
		{ scope: 'worker' },
	],
	builtEditor: [
		async ({ context, browserName }, runTest) => {
			await serveBuiltEditor(context, browserName);
			try {
				await runTest();
			} finally {
				await context.unrouteAll({ behavior: 'ignoreErrors' });
				await context.close();
				await cleanupProjects(context);
			}
		},
		{ auto: true },
	],
});
