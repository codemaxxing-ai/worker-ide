import { Chat } from '@ai-sdk/react';
import { describe, expect, it, vi } from 'vitest';

import { regenerateAgentAnswer } from './agent-regeneration';

import type { AgentMessage } from '@shared/agent-chat';
import type { UIMessageChunk } from 'ai';

const mocks = vi.hoisted(() => ({ history: vi.fn() }));
vi.mock('@/lib/api-client', () => ({
	createApiClient: () => ({ agent: { sessions: { ':sessionId': { history: { $get: mocks.history } } } } }),
}));

describe('native regeneration from original history', () => {
	it('regenerates an answer outside hydration without sending compaction summaries or needing the answer page', async () => {
		const user: AgentMessage = { id: 'original-user', role: 'user', parts: [{ type: 'text', text: 'Original request' }] };
		mocks.history.mockResolvedValue(Response.json({ messages: [user] }));
		const sent: AgentMessage[][] = [];
		const sdk = new Chat<AgentMessage>({
			messages: [{ id: '__compaction:summary', role: 'assistant', parts: [{ type: 'text', text: 'Inference summary' }] }],
			transport: {
				sendMessages: async ({ messages }) => {
					sent.push(messages);
					return new ReadableStream<UIMessageChunk>({ start: (controller) => controller.close() });
				},
				reconnectToStream: async () => new ReadableStream<UIMessageChunk>({ start: (controller) => controller.close() }),
			},
		});
		await regenerateAgentAnswer(
			'project',
			'session',
			{ id: 'oversized-old-answer', role: 'assistant' },
			{
				setMessages: (messages) => {
					sdk.messages = messages;
				},
				regenerate: () => sdk.regenerate(),
			},
		);
		expect(mocks.history).toHaveBeenCalledWith(
			{
				param: { sessionId: 'session' },
				query: { leafId: 'oversized-old-answer', before: 'oversized-old-answer' },
			},
			{ init: { signal: undefined } },
		);
		expect(sent).toEqual([[user]]);
	});
	it('retries an unanswered user request through the same native path', async () => {
		const user: AgentMessage = { id: 'user', role: 'user', parts: [{ type: 'text', text: 'Request' }] };
		mocks.history.mockResolvedValue(Response.json({ messages: [user] }));
		const chat = { setMessages: vi.fn(), regenerate: vi.fn(async () => {}) };
		await regenerateAgentAnswer('project', 'session', user, chat);
		expect(mocks.history).toHaveBeenLastCalledWith(
			{ param: { sessionId: 'session' }, query: { leafId: 'user', before: undefined } },
			{ init: { signal: undefined } },
		);
		expect(chat.setMessages).toHaveBeenCalledWith([user]);
		expect(chat.regenerate).toHaveBeenCalledOnce();
	});
	it('does not start inference when stopped while the original branch prefix is loading', async () => {
		const page = Promise.withResolvers<Response>();
		mocks.history.mockReturnValue(page.promise);
		const chat = { setMessages: vi.fn(), regenerate: vi.fn(async () => {}) };
		const controller = new AbortController();
		const pending = regenerateAgentAnswer('project', 'session', { id: 'answer', role: 'assistant' }, chat, controller.signal);
		controller.abort();
		page.resolve(Response.json({ messages: [{ id: 'user', role: 'user', parts: [] }] }));
		await expect(pending).rejects.toThrow('aborted');
		expect(chat.regenerate).not.toHaveBeenCalled();
		expect(chat.setMessages).not.toHaveBeenCalled();
	});
});
