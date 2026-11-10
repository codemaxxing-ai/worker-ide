import { beforeEach, describe, expect, it, vi } from 'vitest';

import { acknowledgeAgentSubmission, prepareAgentSubmission } from './agent-submission';

import type { UserMessagePart } from '@shared/types';

beforeEach(() => sessionStorage.clear());
describe('durable chat admission identity', () => {
	it('reuses both session and message identity when the response was lost', async () => {
		const first = await prepareAgentSubmission('project', undefined, [{ type: 'text', content: 'Write a file' }]);
		expect(await prepareAgentSubmission('project', undefined, [{ type: 'text', content: 'Write a file' }])).toEqual(first);
	});
	it('allows an intentional repeated message after acknowledgement', async () => {
		const first = await prepareAgentSubmission('project', undefined, [{ type: 'text', content: 'Hello' }]);
		acknowledgeAgentSubmission(first.key);
		const repeated = await prepareAgentSubmission('project', undefined, [{ type: 'text', content: 'Hello' }]);
		expect(repeated.messageId).not.toBe(first.messageId);
	});
	it('does not share pending messages across projects or edited input', async () => {
		const first = await prepareAgentSubmission('project', undefined, [{ type: 'text', content: 'First' }]);
		const other = await prepareAgentSubmission('other', undefined, [{ type: 'text', content: 'First' }]);
		const edited = await prepareAgentSubmission('project', undefined, [{ type: 'text', content: 'Edited' }]);
		expect(other.messageId).not.toBe(first.messageId);
		expect(edited.messageId).not.toBe(first.messageId);
	});
	it('stores a bounded identity for large attachments and restores it after reload', async () => {
		const parts = [
			{ type: 'image', url: `data:image/png;base64,${'a'.repeat(6 * 1024 * 1024)}`, mediaType: 'image/png' },
		] satisfies UserMessagePart[];
		const first = await prepareAgentSubmission('large-image', undefined, parts);
		expect(sessionStorage.getItem(first.key)?.length).toBeLessThan(256);
		vi.resetModules();
		const reloaded = await import('./agent-submission');
		expect(await reloaded.prepareAgentSubmission('large-image', undefined, parts)).toEqual(first);
	});
	it('retains retry identity when tab storage is unavailable', async () => {
		const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new DOMException('Storage is full', 'QuotaExceededError');
		});
		try {
			const parts = [{ type: 'text', content: 'Retry after a lost response' }] satisfies UserMessagePart[];
			const first = await prepareAgentSubmission('unavailable-storage', undefined, parts);
			expect(await prepareAgentSubmission('unavailable-storage', undefined, parts)).toEqual(first);
			acknowledgeAgentSubmission(first.key);
			const repeated = await prepareAgentSubmission('unavailable-storage', undefined, parts);
			expect(repeated.messageId).not.toBe(first.messageId);
		} finally {
			storage.mockRestore();
		}
	});
});
