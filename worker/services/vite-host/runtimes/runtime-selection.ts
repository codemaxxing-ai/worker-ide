import { Parser } from 'acorn';
import { tsPlugin } from 'acorn-typescript';
import { z } from 'zod';

import { WorkerCapabilityError } from '@shared/worker-runtime-error';

import templateViteConfig from '../../../fixtures/minimal/vite.config.ts?raw';

// @ts-expect-error -- acorn-typescript's published plugin signature differs from acorn's compatible runtime API.
const ConfigurationParser = Parser.extend(tsPlugin());

export const VITE_CONFIG_PATHS = [
	'vite.config.ts',
	'vite.config.js',
	'vite.config.mts',
	'vite.config.mjs',
	'vite.config.cts',
	'vite.config.cjs',
];

const manifestSchema = z.object({
	dependencies: z.record(z.string(), z.string()).optional(),
	devDependencies: z.record(z.string(), z.string()).optional(),
});

function readManifest(files: Record<string, string>): z.infer<typeof manifestSchema> | undefined {
	try {
		return manifestSchema.parse(JSON.parse(files['/package.json'] ?? files['package.json'] ?? '{}'));
	} catch {
		return;
	}
}

export function declaresVinext(files: Record<string, string>): boolean {
	const manifest = readManifest(files);
	return manifest?.dependencies?.vinext !== undefined || manifest?.devDependencies?.vinext !== undefined;
}

/** Check the configuration at compilation time; never silently discard user plugins. */
export function assertWorkerCapabilities(files: Record<string, string>): void {
	const configurations = VITE_CONFIG_PATHS.map((path) => files[`/${path}`] ?? files[path]).filter((value) => value !== undefined);
	for (const configuration of configurations) {
		if (configuration.trim() === templateViteConfig.trim()) continue;
		// Invalid configuration remains a syntax error, not an automatic promotion.
		ConfigurationParser.parse(configuration, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
		throw new WorkerCapabilityError('Custom Vite configuration requires native Vite');
	}
	if (declaresVinext(files) && !Object.keys(files).some((path) => path.replace(/^\/+/, '').startsWith('app/'))) {
		throw new WorkerCapabilityError('This vinext router requires native Vite');
	}
}
