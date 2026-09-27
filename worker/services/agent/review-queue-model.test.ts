import { describe, expect, it } from 'vitest';

import { derivePendingChangeFromWorkspace, parsePendingChangesRecord, resolveDecisionFromHunks } from './review-queue-model';

import type { PendingFileChange } from '@shared/types';

const pendingChange: PendingFileChange = {
	path: '/src/app.ts',
	action: 'edit',
	beforeContent: 'before',
	afterContent: 'after',
	snapshotId: undefined,
	status: 'pending',
	hunkStatuses: ['pending'],
	sessionId: 'session-1',
};

describe('review queue persistence model', () => {
	it('sanitizes malformed persisted review data without discarding valid changes', () => {
		const parsed = parsePendingChangesRecord(
			JSON.stringify({
				valid: {
					...pendingChange,
					action: 'unknown',
					hunkStatuses: ['approved', 'invalid', 'pending'],
					hunkSessionIds: [['session-1', 42], [], 'invalid'],
					sessionIds: ['session-1', 42],
				},
				invalid: { path: '/src/other.ts' },
			}),
		);

		expect(parsed).toEqual({
			valid: {
				...pendingChange,
				hunkStatuses: ['approved', 'pending'],
				hunkSessionIds: [['session-1']],
				sessionIds: ['session-1'],
			},
		});
		expect(parsePendingChangesRecord('{bad json')).toEqual({});
	});

	it('reconciles a pending edit with the current workspace content', () => {
		expect(derivePendingChangeFromWorkspace(pendingChange, 'before')).toBeUndefined();
		expect(derivePendingChangeFromWorkspace(pendingChange, 'new content')).toEqual({
			...pendingChange,
			action: 'edit',
			afterContent: 'new content',
		});
		expect(derivePendingChangeFromWorkspace(pendingChange)).toEqual({
			...pendingChange,
			action: 'delete',
			afterContent: undefined,
		});
	});

	it('preserves mixed hunk decisions when resolving a review entry', () => {
		expect(resolveDecisionFromHunks(['approved', 'rejected'])).toBe('mixed');
	});
});
