import { Buffer } from 'node:buffer';

import { z } from 'zod';

const outputPath = z
	.string()
	.refine(
		(path) => path !== '' && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0') && !path.split('/').includes('..'),
	);

export const nativeBuildSchema = z
	.object({
		clientFiles: z.record(outputPath, z.base64()),
		serverModules: z.record(outputPath, z.string()).optional(),
		mainModule: outputPath.optional(),
	})
	.refine(
		(artifact) =>
			artifact.serverModules === undefined
				? artifact.mainModule === undefined
				: artifact.mainModule !== undefined && artifact.serverModules[artifact.mainModule] !== undefined,
		'Native server entry is missing',
	)
	.refine(
		(artifact) =>
			Object.values(artifact.clientFiles).reduce((total, bytes) => total + Buffer.byteLength(bytes, 'base64'), 0) +
				Object.values(artifact.serverModules ?? {}).reduce((total, code) => total + Buffer.byteLength(code), 0) <=
			8 * 1024 * 1024,
		'Native build exceeds the 8 MiB artifact limit',
	);

export type NativeBuild = z.infer<typeof nativeBuildSchema>;
