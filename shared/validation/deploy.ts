import { z } from 'zod';

function containsControlCharacters(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if ((codePoint >= 0 && codePoint <= 31) || codePoint === 127) {
			return true;
		}
	}

	return false;
}

export const deployAccountIdSchema = z
	.string()
	.trim()
	.min(1, 'Account ID is required')
	.max(64, 'Account ID must be at most 64 characters')
	.regex(/^[a-f\d]+$/i, 'Account ID must be a hexadecimal string');

export const deployWorkerNameSchema = z
	.string()
	.trim()
	.min(1, 'Worker name is required')
	.max(24, 'Worker name must be at most 24 characters')
	.refine((value) => /[a-z\d]/i.test(value), 'Worker name must contain at least one letter or number')
	.refine((value) => !containsControlCharacters(value), 'Worker name must not contain control characters');

export const savedDeployAccountSchema = z.object({
	accountId: deployAccountIdSchema,
});

export type SavedDeployAccountParsed = z.infer<typeof savedDeployAccountSchema>;

export const deployRequestSchema = z
	.object({
		mode: z.enum(['permanent', 'temporary']),
		accountId: deployAccountIdSchema.optional(),
		workerName: deployWorkerNameSchema.optional(),
	})
	.superRefine((value, context) => {
		if (value.mode === 'permanent' && !value.accountId) {
			context.addIssue({ code: 'custom', path: ['accountId'], message: 'Account ID is required' });
		}
	});

export const deployFormSchema = z.object({
	accountId: deployAccountIdSchema,
	workerName: deployWorkerNameSchema,
});
