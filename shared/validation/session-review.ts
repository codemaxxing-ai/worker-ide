import { z } from 'zod';

import { filePathSchema } from './file-system';
import { LIMITS } from './limits';

export const sessionIdSchema = z
	.string()
	.min(1, 'Session ID is required')
	.max(LIMITS.SESSION_ID_MAX_LENGTH, `Session ID must be at most ${LIMITS.SESSION_ID_MAX_LENGTH} characters`)
	.regex(/^[a-z0-9]+$/, 'Session ID must contain only lowercase alphanumeric characters');
export const sessionTitleSchema = z
	.string()
	.trim()
	.min(1, 'Title is required')
	.max(LIMITS.TITLE_MAX_LENGTH, `Title must be at most ${LIMITS.TITLE_MAX_LENGTH} characters`);
export const pendingFileChangeSchema = z.object({
	path: z.string(),
	action: z.enum(['create', 'edit', 'delete', 'move']),
	beforeContent: z
		.string()
		.optional()
		.transform((value) => value),
	afterContent: z
		.string()
		.optional()
		.transform((value) => value),
	snapshotId: z
		.string()
		.optional()
		.transform((value) => value),
	status: z.enum(['pending', 'approved', 'rejected']),
	hunkStatuses: z.array(z.enum(['pending', 'approved', 'rejected'])),
	hunkSessionIds: z.array(z.array(z.string())).optional(),
	sessionId: z.string(),
	sessionIds: z.array(z.string()).optional(),
	reviewId: z.string().optional(),
});

export const pendingChangesFileSchema = z.record(z.string(), pendingFileChangeSchema);

export const reviewHunkStatusSchema = z.enum(['pending', 'approved', 'rejected']);

export const reviewEntrySchema = z.object({
	id: z.string(),
	path: z.string(),
	action: z.enum(['create', 'edit', 'delete', 'move']),
	beforeContent: z.string().optional(),
	afterContent: z.string().optional(),
	snapshotId: z.string().optional(),
	status: z.literal('pending'),
	hunkStatuses: z.array(reviewHunkStatusSchema),
	hunkSessionIds: z.array(z.array(z.string())).optional(),
	latestSessionId: z.string(),
	sessionIds: z.array(z.string()),
	diffSignature: z.string(),
	updatedAt: z.number(),
});

export const reviewResolveSchema = z.object({
	decision: z.enum(['accept', 'reject']),
	liveContent: z.string().optional(),
});

export const reviewResolveManySchema = z.object({
	decision: z.enum(['accept', 'reject']),
	sessionId: z.string().optional(),
	reviewIds: z.array(z.string()).optional(),
	liveContents: z.record(z.string(), z.string()).optional(),
});

export const reviewHunkUpdateSchema = z.object({
	hunkStatuses: z.array(reviewHunkStatusSchema),
	liveContent: z.string().optional(),
});

export const debugLogIdSchema = z
	.string()
	.min(1, 'Debug log ID is required')
	.max(64, 'Debug log ID must be at most 64 characters')
	.regex(/^[a-z0-9-]+$/, 'Debug log ID must contain only lowercase alphanumeric characters and hyphens');
export const snapshotIdSchema = z
	.string()
	.min(1, 'Snapshot ID is required')
	.max(LIMITS.SNAPSHOT_ID_MAX_LENGTH, `Snapshot ID must be at most ${LIMITS.SNAPSHOT_ID_MAX_LENGTH} characters`)
	.regex(/^[a-f0-9]+$/, 'Snapshot ID must be a valid hexadecimal string');
export const revertFileSchema = z.object({
	path: filePathSchema,
	snapshotId: snapshotIdSchema,
});

export type RevertFileInput = z.infer<typeof revertFileSchema>;

export const revertCascadeSchema = z.object({
	snapshotIds: z.array(snapshotIdSchema).min(1).max(20),
});

export type RevertCascadeInput = z.infer<typeof revertCascadeSchema>;
export const sessionIdQuerySchema = z.object({
	id: sessionIdSchema,
});
