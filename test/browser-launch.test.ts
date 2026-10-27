import { execFile } from 'node:child_process';
import { access, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { browserLaunchOptions } from './browser-launch';

describe('browser launch isolation', () => {
	it('keeps other browsers and non-macOS launches unchanged', async () => {
		const options = { timeout: 15_000 };
		await using chromium = await browserLaunchOptions('chromium', options, 'darwin');
		await using firefox = await browserLaunchOptions('firefox', options, 'linux');
		expect(chromium.options).toBe(options);
		expect(firefox.options).toBe(options);
	});
	it('preserves an explicitly configured app-data directory', async () => {
		const options = { env: { CFFIXED_USER_HOME: '/custom/firefox' } };
		await using launch = await browserLaunchOptions('firefox', options, 'darwin');
		expect(launch.options).toBe(options);
	});
	it.skipIf(process.platform !== 'darwin')('creates private app data per worker and removes it on disposal', async () => {
		const options = { timeout: 15_000, env: { TEST_BROWSER_VALUE: 'preserved' } };
		const launch = await browserLaunchOptions('firefox', options);
		const directory = launch.options.env?.CFFIXED_USER_HOME;
		if (typeof directory !== 'string') throw new Error('Missing isolated app data');
		try {
			const library = path.join(directory, 'Library');
			await mkdir(library);
			await promisify(execFile)('chmod', ['+a', 'everyone deny delete', library]);
			await using second = await browserLaunchOptions('firefox', options);
			expect(second.options.env?.CFFIXED_USER_HOME).not.toBe(directory);
			const information = await stat(directory);
			expect(information.mode & 0o777).toBe(0o700);
			expect(launch.options.env?.TEST_BROWSER_VALUE).toBe('preserved');
			expect(launch.options.timeout).toBe(15_000);
			expect(options.env).toEqual({ TEST_BROWSER_VALUE: 'preserved' });
		} finally {
			await launch[Symbol.asyncDispose]();
		}
		await expect(access(directory)).rejects.toThrow();
	});
});
