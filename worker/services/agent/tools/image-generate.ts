import { env } from 'cloudflare:workers';

import { ToolErrorCode, toolError } from '@shared/tool-errors';
import { createHmrUpdateForFile } from '@shared/types';
import { coordinatorNamespace } from '@worker/lib/durable-object-namespaces';
import { isHiddenPath, isPathSafe } from '@worker/lib/path-utilities';
import { fs } from '@worker/lib/project-fs';

import type { FileChange, SendEventFunction, ToolDefinition, ToolExecutorContext, ToolResult } from '../types';

const IMAGE_WIDTH = 1024;
const IMAGE_HEIGHT = 1024;
const IMAGE_STEPS = 20;
const LUCID_ORIGIN_MODEL = '@cf/leonardo/lucid-origin';

const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

const DESCRIPTION = `Generate an image from a text prompt using Cloudflare Workers AI (Lucid Origin model by Leonardo.AI).
The image is saved at the specified path.

Usage:
- Provide a descriptive text prompt and a file path ending in .png, .jpg, .jpeg, or .webp.
- The image is generated at ${IMAGE_WIDTH}x${IMAGE_HEIGHT} resolution with ${IMAGE_STEPS} inference steps.
- Parent directories are created automatically if they don't exist.
- This tool creates a new file — it will NOT overwrite an existing file.`;

export const definition: ToolDefinition = {
	name: 'image_generate',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {
			prompt: { type: 'string', description: 'Text description of the image to generate' },
			file_path: { type: 'string', description: 'Absolute path where the image will be saved (must end in .png, .jpg, .jpeg, or .webp)' },
		},
		required: ['prompt', 'file_path'],
	},
};

export async function execute(
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
	queryChanges?: FileChange[],
): Promise<ToolResult> {
	const { projectRoot, projectId } = context;
	const { prompt, file_path: imagePath } = input;

	// Validate path
	if (!isPathSafe(projectRoot, imagePath)) {
		return toolError(ToolErrorCode.INVALID_PATH, 'Invalid file path');
	}

	if (isHiddenPath(imagePath)) {
		return toolError(ToolErrorCode.INVALID_PATH, `Access denied: ${imagePath}`);
	}

	const extension = imagePath.slice(imagePath.lastIndexOf('.')).toLowerCase();
	if (!SUPPORTED_EXTENSIONS.has(extension)) {
		return toolError(ToolErrorCode.INVALID_PATH, 'Image path must end in .png, .jpg, .jpeg, or .webp');
	}

	// Check if file already exists
	const fileExists = await fs.stat(`${projectRoot}${imagePath}`).then(
		() => true,
		() => false,
	);
	if (fileExists) return toolError(ToolErrorCode.NOT_ALLOWED, `File already exists: ${imagePath}. Choose a different path.`);

	sendEvent('status', { message: `Generating image: "${prompt}"...` });

	// Call Workers AI — Lucid Origin takes plain JSON input and returns raw image bytes.
	// The binding returns a Uint8Array that can be written directly to disk.
	let imageBytes: Uint8Array;
	try {
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- TODO: Remove once `wrangler types` includes Lucid Origin in AiModels
		const model = LUCID_ORIGIN_MODEL as Parameters<typeof env.AI.run>[0];
		const result = await env.AI.run(
			model,
			{
				prompt,
				width: IMAGE_WIDTH,
				height: IMAGE_HEIGHT,
				steps: IMAGE_STEPS,
			},
			{
				gateway: {
					id: 'default',
					metadata: {
						app: 'worker-ide',
						type: 'gen_image',
						project_id: projectId,
						org_id: '',
						user_id: context.userId ?? '',
					},
				},
				extraHeaders: {
					'cf-aig-collect-log-payload': 'false',
				},
			},
		);

		if (result instanceof Uint8Array) {
			imageBytes = result;
		} else if (result instanceof ReadableStream) {
			// Some bindings return a ReadableStream — collect all chunks
			const reader = result.getReader();
			const chunks: Uint8Array[] = [];
			let done = false;
			while (!done) {
				const read = await reader.read();
				done = read.done;
				if (read.value) {
					chunks.push(read.value);
				}
			}
			const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
			imageBytes = new Uint8Array(totalLength);
			let offset = 0;
			for (const chunk of chunks) {
				imageBytes.set(chunk, offset);
				offset += chunk.length;
			}
		} else {
			return toolError(ToolErrorCode.NOT_ALLOWED, 'Unexpected response format from image generation model');
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return toolError(ToolErrorCode.NOT_ALLOWED, `Image generation failed: ${message}`);
	}

	if (imageBytes.length === 0) {
		return toolError(ToolErrorCode.NOT_ALLOWED, 'Image generation returned empty data');
	}

	// Create parent directories if needed
	const directory = imagePath.slice(0, imagePath.lastIndexOf('/'));
	if (directory) {
		await fs.mkdir(`${projectRoot}${directory}`, { recursive: true });
	}

	// Write the image file
	await fs.writeFile(`${projectRoot}${imagePath}`, imageBytes);

	// Track file change for snapshots
	if (queryChanges) {
		queryChanges.push({
			path: imagePath,
			action: 'create',
			beforeContent: undefined,
			afterContent: imageBytes,
			isBinary: true,
		});
	}

	// Trigger HMR update so the preview refreshes
	const coordinatorStub = coordinatorNamespace.getByName(`project:${projectId}`);
	await coordinatorStub.triggerUpdate(createHmrUpdateForFile(imagePath));

	// Send file changed event for UI
	sendEvent('file_changed', {
		path: imagePath,
		action: 'create',
		isBinary: true,
	});

	const sizeKilobytes = (imageBytes.length / 1024).toFixed(1);

	return {
		title: imagePath,
		metadata: { prompt, width: IMAGE_WIDTH, height: IMAGE_HEIGHT, steps: IMAGE_STEPS, sizeKilobytes },
		output: `Generated image saved to ${imagePath} (${IMAGE_WIDTH}x${IMAGE_HEIGHT}, ${sizeKilobytes} KB)`,
	};
}
