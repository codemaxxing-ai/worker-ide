import { describe, expect, it, vi } from 'vitest';

import { AgentSessionStore } from './session-store';
import { chatMessageToSessionMessage } from '../services/agent/session-messages';

import type { ChatMessage } from '@shared/types';
import type { SessionInfo, SessionMessage } from 'agents/experimental/memory/session';

const databaseMocks = vi.hoisted(() => ({
	replaceSessionMessageMetadata: vi.fn(),
	readSessionMessageMetadata: vi.fn(() => []),
	readSessionMetadata: vi.fn(() => {}),
	upsertSessionMetadata: vi.fn(),
}));

vi.mock('./db', () => ({
	readSessionMessageMetadata: databaseMocks.readSessionMessageMetadata,
	readSessionMetadata: databaseMocks.readSessionMetadata,
	replaceSessionMessageMetadata: databaseMocks.replaceSessionMessageMetadata,
	upsertSessionMetadata: databaseMocks.upsertSessionMetadata,
}));

function createMessage(id: string, content: string): ChatMessage {
	return {
		id,
		role: 'user',
		parts: [{ type: 'text', content }],
		createdAt: Date.now(),
	};
}

function createSessionStore(initialHistory: SessionMessage[]) {
	const history = [...initialHistory];
	const appendAll = vi.fn(async (_sessionId: string, messages: SessionMessage[]) => {
		history.push(...messages);
	});
	const clearMessages = vi.fn(() => {
		history.length = 0;
	});
	const get = vi.fn((sessionId: string): SessionInfo => ({
		id: sessionId,
		name: 'Session',
		created_at: new Date().toISOString(),
	}));

	return {
		store: new AgentSessionStore({} as never, {
			get,
			getHistory: () => [...history],
			clearMessages,
			appendAll,
		}),
		appendAll,
		clearMessages,
	};
}

describe('AgentSessionStore.syncHistory', () => {
	it('persists complete text and tool pairs while retaining attachment and review metadata', async () => {
		const content = 'complete history '.repeat(2000);
		const messages: ChatMessage[] = [
			{
				id: 'original-user',
				role: 'user',
				authorUserId: 'author',
				createdAt: 123_000,
				metadata: { snapshotId: 'review' },
				parts: [
					{ type: 'text', content },
					{ type: 'image', url: 'data:image/png;base64,aGVsbG8=', mediaType: 'image/png' },
				],
			},
			{
				id: 'original-assistant',
				role: 'assistant',
				parts: [
					{ type: 'reasoning', content },
					{ type: 'tool-call', toolCallId: 'execution', toolName: 'exec', arguments: { command: content } },
					{ type: 'tool-result', toolCallId: 'execution', toolName: 'exec', result: content },
				],
			},
		];
		const { store, appendAll } = createSessionStore([]);
		await store.syncHistory('session', messages);
		expect(appendAll).toHaveBeenCalledWith(
			'session',
			messages.map((message) => chatMessageToSessionMessage(message)),
			undefined,
		);
		expect(databaseMocks.replaceSessionMessageMetadata).toHaveBeenLastCalledWith({}, 'session', [
			expect.objectContaining({
				messageId: 'original-user',
				authorUserId: 'author',
				snapshotId: 'review',
				partsJson: JSON.stringify(messages[0].parts),
			}),
		]);
	});

	it('appends only the new suffix when history shares the existing prefix', async () => {
		const initial = [chatMessageToSessionMessage(createMessage('m1', 'one'))];
		const { store, appendAll, clearMessages } = createSessionStore(initial);

		await store.syncHistory('session-1', [createMessage('m1', 'one'), createMessage('m2', 'two')]);

		expect(clearMessages).not.toHaveBeenCalled();
		expect(appendAll).toHaveBeenCalledOnce();
		expect(appendAll.mock.calls[0]?.[1]).toHaveLength(1);
		expect(appendAll.mock.calls[0]?.[1][0]?.id).toBe('m2');
	});

	it('falls back to a full rewrite when the history diverges', async () => {
		const initial = [chatMessageToSessionMessage(createMessage('m1', 'one'))];
		const { store, appendAll, clearMessages } = createSessionStore(initial);

		await store.syncHistory('session-1', [createMessage('m9', 'replacement')]);

		expect(clearMessages).toHaveBeenCalledOnce();
		expect(appendAll).toHaveBeenCalledOnce();
		expect(appendAll.mock.calls[0]?.[1][0]?.id).toBe('m9');
	});
});
