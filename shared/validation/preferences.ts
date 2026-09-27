import { z } from 'zod';

import { USER_PREFERENCE_KEYS } from '../constants';

export const editorSessionSchema = z.object({
	openFiles: z.array(z.string()),
	activeFile: z.string().optional(),
	scrollPositions: z.record(z.string(), z.number()).default({}),
	cursorPositions: z.record(z.string(), z.object({ line: z.number(), column: z.number() })).default({}),
});

export type EditorSessionParsed = z.infer<typeof editorSessionSchema>;

export const pushSubscriptionBodySchema = z.object({
	endpoint: z.string().min(1),
	key: z.string().min(1),
	auth: z.string().min(1),
});

export const pushUnsubscribeBodySchema = z.object({
	endpoint: z.string().min(1),
});

export const pushNotificationPreferenceBodySchema = z.object({
	endpoint: z.string().min(1),
	enabled: z.boolean(),
});

export const userPreferencesBodySchema = z
	.record(z.string(), z.string())
	.transform((record) => {
		const filtered: Record<string, string> = {};
		for (const key of USER_PREFERENCE_KEYS) {
			if (key in record) {
				filtered[key] = record[key];
			}
		}
		return filtered;
	})
	.refine((record) => Object.keys(record).length > 0, {
		message: 'At least one valid preference key is required',
	});
