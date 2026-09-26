import { z } from 'zod';

const safeGitPath = z
	.string()
	.min(1, 'Path is required')
	.refine((path) => !path.includes('..'), 'Path must not contain ".."')
	.refine((path) => !path.includes('\0'), 'Path must not contain null bytes');
export const gitStageSchema = z.object({
	paths: z.array(safeGitPath).min(1, 'At least one path is required'),
});

export type GitStageInput = z.infer<typeof gitStageSchema>;
export const gitDiscardSchema = z.object({
	path: safeGitPath,
});

export type GitDiscardInput = z.infer<typeof gitDiscardSchema>;
export const gitCommitSchema = z.object({
	message: z.string().min(1, 'Commit message is required').max(5000, 'Commit message is too long'),
	amend: z.boolean().optional(),
});

export type GitCommitInput = z.infer<typeof gitCommitSchema>;
export const gitBranchSchema = z.object({
	name: z
		.string()
		.min(1, 'Branch name is required')
		.max(255, 'Branch name is too long')
		.refine((name) => !name.includes(' '), 'Branch name cannot contain spaces')
		.refine((name) => !name.startsWith('-'), 'Branch name cannot start with a dash')
		.refine((name) => !name.includes('..'), 'Branch name cannot contain ".."')
		.refine((name) => !name.endsWith('.lock'), 'Branch name cannot end with ".lock"'),
	checkout: z.boolean().optional(),
});

export type GitBranchInput = z.infer<typeof gitBranchSchema>;
export const gitBranchRenameSchema = z.object({
	oldName: z.string().min(1, 'Old branch name is required').max(255, 'Branch name is too long'),
	newName: z.string().min(1, 'New branch name is required').max(255, 'Branch name is too long'),
});

export type GitBranchRenameInput = z.infer<typeof gitBranchRenameSchema>;
export const gitCheckoutSchema = z.object({
	reference: z.string().min(1, 'Reference is required').max(255, 'Reference is too long'),
});

export type GitCheckoutInput = z.infer<typeof gitCheckoutSchema>;
export const gitMergeSchema = z.object({
	branch: z.string().min(1, 'Branch name is required').max(255, 'Branch name is too long'),
});

export type GitMergeInput = z.infer<typeof gitMergeSchema>;
export const gitTagSchema = z.object({
	name: z.string().min(1, 'Tag name is required').max(255, 'Tag name is too long'),
	reference: z.string().optional(),
});

export type GitTagInput = z.infer<typeof gitTagSchema>;
export const gitLogQuerySchema = z.object({
	reference: z.string().optional(),
	depth: z.coerce.number().int().min(1).max(500).optional(),
});

export type GitLogQuery = z.infer<typeof gitLogQuerySchema>;
export const gitGraphQuerySchema = z.object({
	maxCount: z.coerce.number().int().min(1).max(500).optional(),
});

export type GitGraphQuery = z.infer<typeof gitGraphQuerySchema>;
export const gitDiffQuerySchema = z.object({
	path: safeGitPath,
});

export type GitDiffQuery = z.infer<typeof gitDiffQuerySchema>;
export const gitCommitDiffQuerySchema = z.object({
	objectId: z.string().min(1, 'Object ID is required'),
});

export type GitCommitDiffQuery = z.infer<typeof gitCommitDiffQuerySchema>;
export const gitFileDiffAtCommitQuerySchema = z.object({
	objectId: z.string().min(1, 'Object ID is required'),
	path: safeGitPath,
});

export type GitFileDiffAtCommitQuery = z.infer<typeof gitFileDiffAtCommitQuerySchema>;
export const gitBranchNameQuerySchema = z.object({
	name: z.string().min(1, 'Branch name is required'),
});
export const gitTagNameQuerySchema = z.object({
	name: z.string().min(1, 'Tag name is required'),
});
export const gitCredentialRequestSchema = z.object({});

export type GitCredentialRequestInput = z.infer<typeof gitCredentialRequestSchema>;
