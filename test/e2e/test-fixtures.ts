import { test as baseTest } from 'playwright/test';

import { serveBuiltEditor } from './built-editor';
import { cleanupProjects } from './helpers';

export { expect } from 'playwright/test';

export const test = baseTest.extend<{ builtEditor: void }>({
	builtEditor: [
		async ({ context }, runTest) => {
			await serveBuiltEditor(context);
			try {
				await runTest();
			} finally {
				await context.unrouteAll({ behavior: 'ignoreErrors' });
				await cleanupProjects(context);
			}
		},
		{ auto: true },
	],
});
