import { describe, expect, it } from 'vitest';

import { DEFAULT_AI_MODEL } from '@shared/constants';

import {
	applyPersistedMessageMetadata,
	clearSnapshotFromMessages,
	getCommittedMessages,
	getLastCommittedRequestConfig,
	getPendingUserQuestion,
	getQueuedMessages,
	mergeQueuedMessages,
	promoteNextQueuedMessage,
	serializePersistedMessageMetadata,
	setSnapshotOnLastCommittedUserMessage,
} from './session-history';

import type { ChatMessage } from '@shared/types';

function createUserMessage(
	id: string,
	content: string,
	state: 'queued' | 'committed',
	mode = 'code',
	model = DEFAULT_AI_MODEL,
): ChatMessage {
	return {
		id,
		role: 'user',
		authorUserId: `${id}-author`,
		parts: [{ type: 'text', content }],
		createdAt: 1,
		metadata: {
			request: {
				state,
				mode,
				model,
			},
		},
	};
}

describe('session-history', () => {
	it('restores the most recent unanswered successful question from persisted tool calls', () => {
		const question: ChatMessage = {
			id: 'question',
			role: 'assistant',
			parts: [
				{
					type: 'tool-call',
					toolCallId: 'question-1',
					toolName: 'user_question',
					arguments: { question: 'Which color?', options: 'Red, Blue' },
				},
				{ type: 'tool-result', toolCallId: 'question-1', toolName: 'user_question', result: 'Question for the user: Which color?' },
			],
		};
		const messages = [createUserMessage('request', 'Choose a color', 'committed'), question];

		expect(getPendingUserQuestion(messages)).toEqual({ question: 'Which color?', options: 'Red, Blue' });
		expect(getPendingUserQuestion([...messages, createUserMessage('answer', 'Red', 'committed')])).toBeUndefined();
		expect(getPendingUserQuestion([...messages, createUserMessage('queued', 'Follow up', 'queued')])).toEqual({
			question: 'Which color?',
			options: 'Red, Blue',
		});
	});

	it('does not restore failed or unfinished questions', () => {
		const call: ChatMessage = {
			id: 'question',
			role: 'assistant',
			parts: [{ type: 'tool-call', toolCallId: 'question-1', toolName: 'user_question', arguments: { question: 'Which color?' } }],
		};
		expect(getPendingUserQuestion([call])).toBeUndefined();
		expect(
			getPendingUserQuestion([
				{
					...call,
					parts: [
						...call.parts,
						{ type: 'tool-result', toolCallId: 'question-1', toolName: 'user_question', result: 'Failed', isError: true },
					],
				},
			]),
		).toBeUndefined();
		const result: ChatMessage = {
			id: 'result',
			role: 'assistant',
			parts: [{ type: 'tool-result', toolCallId: 'question-1', toolName: 'user_question', result: 'Question displayed' }],
		};
		expect(getPendingUserQuestion([call, result])).toEqual({ question: 'Which color?', options: '' });
	});

	it('separates committed and queued messages', () => {
		const messages = [createUserMessage('m1', 'first', 'committed'), createUserMessage('m2', 'second', 'queued')];

		expect(getCommittedMessages(messages).map((message) => message.id)).toEqual(['m1']);
		expect(getQueuedMessages(messages).map((message) => message.id)).toEqual(['m2']);
	});

	it('promotes only the next queued message', () => {
		const messages = [
			createUserMessage('m1', 'first', 'committed'),
			createUserMessage('m2', 'second', 'queued', 'plan', '@cf/deepseek-ai/deepseek-v4.1-flash-1017'),
			createUserMessage('m3', 'third', 'queued', 'ask'),
		];

		const { history, promotedMessage } = promoteNextQueuedMessage(messages);

		expect(promotedMessage?.id).toBe('m2');
		expect(history[1]?.metadata?.request?.state).toBe('committed');
		expect(history[2]?.metadata?.request?.state).toBe('queued');
	});

	it('merges queued tail messages when persisting committed history', () => {
		const existingHistory = [createUserMessage('m1', 'first', 'committed'), createUserMessage('m2', 'second', 'queued')];
		const committedHistory = [createUserMessage('m1', 'first', 'committed')];

		expect(mergeQueuedMessages(committedHistory, existingHistory).map((message) => message.id)).toEqual(['m1', 'm2']);
	});

	it('round-trips persisted message metadata rows', () => {
		const history = [
			{
				...createUserMessage('m1', 'first', 'committed', 'plan'),
				metadata: { request: { state: 'committed', mode: 'plan', model: DEFAULT_AI_MODEL }, snapshotId: 'snapshot-1' },
			},
			{ id: 'm2', role: 'assistant' as const, parts: [{ type: 'text', content: 'done' }], createdAt: 2 },
		];

		const rows = serializePersistedMessageMetadata('session-1', history);
		expect(rows).toEqual([
			{
				sessionId: 'session-1',
				messageId: 'm1',
				requestMode: 'plan',
				requestModel: DEFAULT_AI_MODEL,
				requestState: 'committed',
				authorUserId: 'm1-author',
				partsJson: undefined,
				snapshotId: 'snapshot-1',
			},
		]);

		const hydrated = applyPersistedMessageMetadata([{ ...history[0], metadata: undefined }, history[1]], rows);
		expect(hydrated[0]?.metadata?.snapshotId).toBe('snapshot-1');
		expect(hydrated[0]?.metadata?.request?.mode).toBe('plan');
		expect(hydrated[0]?.authorUserId).toBe('m1-author');
	});

	it('restores persisted preview-element parts for user messages', () => {
		const history = [createUserMessage('m1', 'Inspect', 'committed')];
		const rows = [
			{
				sessionId: 'session-1',
				messageId: 'm1',
				requestMode: 'code',
				requestModel: DEFAULT_AI_MODEL,
				requestState: 'committed' as const,
				authorUserId: 'm1-author',
				partsJson: JSON.stringify([
					{ type: 'text', content: 'Inspect ' },
					{
						type: 'preview-element',
						tagName: 'button',
						primarySelector: '#submit',
						locatorCandidates: ['button[aria-label="Submit"]'],
						accessibleName: 'Submit',
						role: 'button',
					},
				]),
				snapshotId: undefined,
			},
		];

		const hydrated = applyPersistedMessageMetadata(history, rows);
		expect(hydrated[0]?.parts).toEqual([
			{ type: 'text', content: 'Inspect ' },
			{
				type: 'preview-element',
				tagName: 'button',
				primarySelector: '#submit',
				locatorCandidates: ['button[aria-label="Submit"]'],
				accessibleName: 'Submit',
				role: 'button',
			},
		]);
	});

	it('updates snapshot metadata on the last committed user message', () => {
		const messages = [createUserMessage('m1', 'first', 'committed'), createUserMessage('m2', 'second', 'queued')];

		const withSnapshot = setSnapshotOnLastCommittedUserMessage(messages, 'snapshot-1');
		expect(withSnapshot[0]?.metadata?.snapshotId).toBe('snapshot-1');

		const cleared = clearSnapshotFromMessages(withSnapshot, 'snapshot-1');
		expect(cleared[0]?.metadata?.snapshotId).toBeUndefined();
	});

	it('uses the last committed request config for the next run', () => {
		const messages = [
			createUserMessage('m1', 'first', 'committed', 'ask', '@cf/deepseek-ai/deepseek-v4.1-flash-1017'),
			createUserMessage('m2', 'second', 'queued', 'plan'),
		];

		expect(getLastCommittedRequestConfig(messages)).toEqual({
			mode: 'ask',
			model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
		});
	});
});
