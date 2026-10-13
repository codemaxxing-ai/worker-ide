import { z } from 'zod';

import templateViteConfig from '../../../fixtures/minimal/vite.config.ts?raw';

export const VITE_CONFIG_PATHS = [
	'vite.config.ts',
	'vite.config.js',
	'vite.config.mts',
	'vite.config.mjs',
	'vite.config.cts',
	'vite.config.cjs',
];

const manifestSchema = z.object({
	workerIde: z.object({ runtime: z.enum(['auto', 'worker', 'container']).optional() }).optional(),
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

/** A configuration the Worker host does not implement must run through real Vite. */
export function selectBuildBackend(files: Record<string, string>): 'worker' | 'container' {
	const manifest = readManifest(files);
	if (!manifest) return 'worker';
	const override = manifest.workerIde?.runtime;
	if (override === 'worker' || override === 'container') return override;
	const configurations = VITE_CONFIG_PATHS.map((path) => files[`/${path}`] ?? files[path]).filter((value) => value !== undefined);
	if (configurations.some((configuration) => configuration.trim() !== templateViteConfig.trim())) return 'container';
	const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
	if (
		Object.keys(dependencies).some(
			(name) => name === 'vinext' || name.startsWith('vite-plugin-') || name.startsWith('@sveltejs/') || name === '@vitejs/plugin-vue',
		)
	)
		return 'container';
	return 'worker';
}
