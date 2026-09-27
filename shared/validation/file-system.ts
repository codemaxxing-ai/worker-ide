import { z } from 'zod';

import { LIMITS } from './limits';

export const filePathSchema = z
	.string()
	.min(1, 'Path is required')
	.max(LIMITS.PATH_MAX_LENGTH, `Path must be at most ${LIMITS.PATH_MAX_LENGTH} characters`)
	.startsWith('/', 'Path must start with /')
	.refine((path) => !path.includes('..'), 'Path cannot contain ".."')
	.refine((path) => path === path.replaceAll(/\/+/g, '/'), 'Path cannot contain consecutive slashes');
export const fileContentSchema = z.string().max(LIMITS.FILE_MAX_SIZE, `File content exceeds maximum size`);
export const writeFileSchema = z.object({
	path: filePathSchema,
	content: fileContentSchema,
});

export type WriteFileInput = z.infer<typeof writeFileSchema>;
export const deleteFileSchema = z.object({
	path: filePathSchema,
});

export type DeleteFileInput = z.infer<typeof deleteFileSchema>;
export const mkdirSchema = z.object({
	path: filePathSchema,
});

export type MkdirInput = z.infer<typeof mkdirSchema>;
export const moveFileSchema = z.object({
	from_path: filePathSchema,
	to_path: filePathSchema,
});

export type MoveFileInput = z.infer<typeof moveFileSchema>;
export const testRunRequestSchema = z.object({
	pattern: z.string().max(500, 'Pattern must be at most 500 characters').optional(),
	testName: z.string().max(500, 'Test name must be at most 500 characters').optional(),
});

export type TestRunRequestInput = z.infer<typeof testRunRequestSchema>;
export const transformCodeSchema = z.object({
	code: z.string(),
	filename: z.string(),
});

export type TransformCodeInput = z.infer<typeof transformCodeSchema>;
export const lintFileRequestSchema = z.object({
	path: filePathSchema,
	content: fileContentSchema,
});
export const lintSingleFixRequestSchema = lintFileRequestSchema.extend({
	from: z.number().int().min(0),
	to: z.number().int().min(0),
});
export const pathQuerySchema = z.object({
	path: filePathSchema,
});
export function isPathSafe(path: string): boolean {
	const result = filePathSchema.safeParse(path);
	return result.success;
}
