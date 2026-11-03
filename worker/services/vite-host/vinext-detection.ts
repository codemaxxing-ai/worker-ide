import { z } from 'zod';

const manifestSchema = z.object({
	dependencies: z.record(z.string(), z.string()).optional(),
	devDependencies: z.record(z.string(), z.string()).optional(),
});

/**
 * Select the framework from its manifest. Router support is checked separately
 * by the selected host, so unsupported routers cannot accidentally become SPAs.
 */
export function isVinextProject(files: Record<string, string>): boolean {
	const manifestText = files['/package.json'] ?? files['package.json'];
	if (manifestText === undefined) {
		return false;
	}
	try {
		const manifest = manifestSchema.parse(JSON.parse(manifestText));
		return manifest.dependencies?.vinext !== undefined || manifest.devDependencies?.vinext !== undefined;
	} catch {
		return false;
	}
}
