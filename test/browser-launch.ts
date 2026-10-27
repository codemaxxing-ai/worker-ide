import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { LaunchOptions } from 'playwright';

/** Keep automated Firefox out of the real Firefox app-data directory protected by macOS 27. */
export async function browserLaunchOptions(browserName: string, options: LaunchOptions, platform = process.platform) {
	if (browserName !== 'firefox' || platform !== 'darwin' || options.env?.CFFIXED_USER_HOME) {
		return { options, async [Symbol.asyncDispose]() {} };
	}
	const directory = await mkdtemp(path.join(tmpdir(), 'playwright-firefox-app-data-'));
	return {
		options: {
			...options,
			env: {
				...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
				...options.env,
				CFFIXED_USER_HOME: directory,
			},
		},
		async [Symbol.asyncDispose]() {
			// CoreFoundation adds deny-delete ACLs to Downloads/Library in this temporary directory.
			await promisify(execFile)('chmod', ['-RN', directory]);
			await rm(directory, { recursive: true, force: true });
		},
	};
}
