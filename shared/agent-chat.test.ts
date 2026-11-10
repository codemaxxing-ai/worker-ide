import { describe, expect, it } from 'vitest';

import { createAgentUserMessage, parseAgentHistoryPage, pendingAgentQuestion } from './agent-chat';

import type { AgentMessage } from './agent-chat';

describe('native agent message contracts', () => {
	it('accepts an empty page for a new conversation', async () => {
		expect(await parseAgentHistoryPage('{"messages":[]}')).toEqual({ messages: [], before: undefined });
	});
	it('keeps author metadata and image bytes in the native transcript', async () => {
		const message = createAgentUserMessage(
			'message',
			[
				{ type: 'text', content: 'Inspect this' },
				{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,aGVsbG8=', name: 'example.png' },
			],
			{ createdAt: 10, authorUserId: 'author' },
		);
		const page = await parseAgentHistoryPage(JSON.stringify({ messages: [message], before: 'earlier' }));
		expect(page.messages).toEqual([message]);
		expect(page.before).toBe('earlier');
	});
	it('restores a question from its committed tool output until a user answers', () => {
		const question: AgentMessage = {
			id: 'assistant',
			role: 'assistant',
			parts: [
				{
					type: 'dynamic-tool',
					toolName: 'user_question',
					toolCallId: 'question',
					state: 'output-available',
					input: { question: 'Which color?' },
					output: { title: 'Choose', metadata: { question: 'Which color?', options: ['Red', 'Blue'] }, output: 'Question shown' },
				},
			],
		};
		expect(pendingAgentQuestion([question])).toEqual({ question: 'Which color?', options: ['Red', 'Blue'] });
		expect(
			pendingAgentQuestion([question, createAgentUserMessage('answer', [{ type: 'text', content: 'Blue' }], { createdAt: 20 })]),
		).toBeUndefined();
	});
	it('rejects malformed native history at the API boundary', async () => {
		await expect(parseAgentHistoryPage('{"messages":[{"role":"unknown"}]}')).rejects.toThrow();
	});
});
