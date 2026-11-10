import { z } from 'zod';

import type { UserMessagePart } from '@shared/types';

const submissionSchema = z.object({ sessionId: z.string().uuid(), messageId: z.string().uuid(), fingerprint: z.string() });
const pendingSubmissions = new Map<string, z.infer<typeof submissionSchema>>();

/** Reuse admission identity after a dropped HTTP response, including a page reload. */
export async function prepareAgentSubmission(projectId: string, sessionId: string | undefined, parts: UserMessagePart[]) {
	const key = `think-submission:${projectId}:${sessionId ?? 'new'}`;
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)));
	const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
	const pending = pendingSubmissions.get(key);
	if (pending?.fingerprint === fingerprint) return { ...pending, key };
	try {
		const previous = submissionSchema.safeParse(JSON.parse(sessionStorage.getItem(key) ?? '{}'));
		if (previous.success && previous.data.fingerprint === fingerprint) {
			pendingSubmissions.set(key, previous.data);
			return { ...previous.data, key };
		}
	} catch {
		/* A corrupt local draft does not prevent sending. */
	}
	const submission = { sessionId: sessionId ?? crypto.randomUUID(), messageId: crypto.randomUUID(), fingerprint };
	pendingSubmissions.set(key, submission);
	try {
		sessionStorage.setItem(key, JSON.stringify(submission));
	} catch {
		/* Retain retry identity in this tab when storage is unavailable. */
	}
	return { ...submission, key };
}

export function acknowledgeAgentSubmission(key: string): void {
	pendingSubmissions.delete(key);
	try {
		sessionStorage.removeItem(key);
	} catch {
		/* Storage may be unavailable. */
	}
}
