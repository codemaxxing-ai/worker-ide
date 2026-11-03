import { WorkerCapabilityError } from '@shared/worker-runtime-error';

import { isVinextProject } from '../vinext-detection';
import { assertWorkerViteConfig } from './worker-vite-config';

export const VITE_CONFIG_PATHS = [
	'vite.config.ts',
	'vite.config.js',
	'vite.config.mts',
	'vite.config.mjs',
	'vite.config.cts',
	'vite.config.cjs',
];

/** Check the configuration at compilation time; never silently discard user plugins. */
export function assertWorkerCapabilities(files: Record<string, string>): void {
	for (const path of VITE_CONFIG_PATHS) {
		const configuration = files[`/${path}`] ?? files[path];
		if (configuration !== undefined) assertWorkerViteConfig(configuration, path);
	}
	if (!isVinextProject(files)) return;
	const paths = Object.keys(files).map((path) => path.replace(/^\/+/, ''));
	if (paths.some((path) => path.startsWith('app/'))) return;
	if (paths.some((path) => /^(?:pages|src\/(?:app|pages))\//.test(path)))
		throw new WorkerCapabilityError('This vinext router requires native Vite');
	throw new Error('vinext requires an app or pages directory');
}
