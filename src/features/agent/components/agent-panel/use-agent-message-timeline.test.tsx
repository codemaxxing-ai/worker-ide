import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useAgentMessageTimeline } from './use-agent-message-timeline';

import type { ChatMessage } from '@shared/types';

function userMessage(id: string, state: 'queued' | 'committed' = 'committed'): ChatMessage {
	return { id, role: 'user', parts: [], metadata: { request: { state } } };
}

describe('agent message timeline', () => {
	it('lets live messages replace their durable versions without duplicating them', () => {
		const durable = userMessage('message-1');
		const live: ChatMessage = { ...durable, parts: [{ type: 'text', content: 'updated' }] };
		const { result } = renderHook(() =>
			useAgentMessageTimeline({
				sessionId: 'session-1',
				currentSession: { sessionId: 'session-1', messages: [live, userMessage('message-2')] },
				sessionSnapshot: { id: 'session-1', history: [durable] },
				optimisticMessages: [],
				optimisticRemovedQueuedMessages: [],
			}),
		);

		expect(result.current.committedMessages).toEqual([live, userMessage('message-2')]);
	});

	it('keeps local queued messages scoped to their session and hides removed server messages', () => {
		const localQueued = userMessage('local', 'queued');
		const queuedFromServer = userMessage('server-queued', 'queued');
		const { result } = renderHook(() =>
			useAgentMessageTimeline({
				sessionId: 'session-1',
				currentSession: { sessionId: 'session-1', messages: [queuedFromServer] },
				sessionSnapshot: undefined,
				optimisticMessages: [
					{ sessionId: 'session-1', message: localQueued, clientOnly: true, submitting: false },
					{ sessionId: 'session-2', message: userMessage('other', 'queued'), clientOnly: true, submitting: false },
				],
				optimisticRemovedQueuedMessages: [{ sessionId: 'session-1', messageId: 'server-queued' }],
			}),
		);

		expect(result.current.queuedMessages).toEqual([localQueued]);
		expect(result.current.localOnlyMessageIds).toEqual(new Set(['local']));
	});
});
