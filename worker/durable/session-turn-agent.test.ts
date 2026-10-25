import { generateText, stepCountIs, streamText, tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { AI_MODELS, CODE_MODE_SYSTEM_PROMPT, DEFAULT_AI_MODEL } from '@shared/constants';

import {
	buildSessionTurnInstructions,
	getTerminalSubmissionResult,
	parseActiveTurnConfiguration,
	shouldWaitForUser,
	SessionTurnAgent,
} from './session-turn-agent';
import { createServerTools } from '../services/agent/tools';
import { createMockContext, createMockSendEvent } from '../services/agent/tools/test-helpers';

import type { ThinkSubmissionInspection } from '@cloudflare/think';
import type { StreamEvent } from '@shared/agent-state';

function submission(status: ThinkSubmissionInspection['status'], error?: string): ThinkSubmissionInspection {
	return {
		submissionId: 'submission-1',
		status,
		error,
		createdAt: 1,
	};
}

describe('session turn lifecycle', () => {
	it.each([false, true])('forwards complete SDK tool input (incremental input: %s)', async (incremental) => {
		const events: StreamEvent[] = [];
		const host = {
			eventQueue: [],
			saveSnapshotChanges: async () => {},
			forwardEvents: async (batch: StreamEvent[]) => {
				events.push(...batch);
			},
		};
		const input = { path: '/app.tsx', content: 'hello' };
		const model = new MockLanguageModelV3({
			doStream: async () => ({
				stream: new ReadableStream({
					start(controller) {
						if (incremental) {
							controller.enqueue({ type: 'tool-input-start', id: 'write-1', toolName: 'write' });
							controller.enqueue({ type: 'tool-input-delta', id: 'write-1', delta: '{"path":"/app.tsx"' });
							controller.enqueue({ type: 'tool-input-delta', id: 'write-1', delta: ',"content":"hello"}' });
							controller.enqueue({ type: 'tool-input-end', id: 'write-1' });
						}
						controller.enqueue({ type: 'tool-call', toolCallId: 'write-1', toolName: 'write', input: JSON.stringify(input) });
						controller.enqueue({
							type: 'finish',
							finishReason: { unified: 'tool-calls', raw: undefined },
							usage: {
								inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
								outputTokens: { total: 1, text: 1, reasoning: 0 },
							},
						});
						controller.close();
					},
				}),
				warnings: [],
			}),
		});
		const result = streamText({
			model,
			prompt: 'Write the file',
			tools: { write: tool({ inputSchema: z.object({ path: z.string(), content: z.string() }), execute: async () => 'saved' }) },
			onChunk: async ({ chunk }) => {
				await Reflect.apply(SessionTurnAgent.prototype.onChunk, host, [{ chunk }]);
			},
		});
		await result.consumeStream();
		expect(events).toContainEqual({ type: 'tool-call-start', toolCallId: 'write-1', toolName: 'write', arguments: input });
		expect(events).toContainEqual({ type: 'tool-call-end', toolCallId: 'write-1', toolName: 'write', result: 'saved' });
	});

	it('cancels queued submissions before the active one without awaiting workspace cancellation', async () => {
		const cancelSubmission = vi.fn(async () => {});
		const cancellation = new Promise<void>(() => {});
		const host = {
			listSubmissions: async () => [submission('running'), { ...submission('pending'), submissionId: 'queued' }],
			cancelWorkspaceCommands: vi.fn(() => cancellation),
			cancelSubmission,
			ctx: { waitUntil: vi.fn() },
		};
		await Reflect.apply(SessionTurnAgent.prototype.cancelActiveSubmissions, host, []);
		expect(cancelSubmission.mock.calls).toEqual([
			['queued', 'Cancelled by user'],
			['submission-1', 'Cancelled by user'],
		]);
		expect(host.cancelWorkspaceCommands).toHaveBeenCalledWith('submission-1');
		expect(host.ctx.waitUntil).toHaveBeenCalledOnce();
	});

	it('removes one queued submission without cancelling the running workspace command', async () => {
		const host = { cancelSubmission: vi.fn(async () => {}), cancelWorkspaceCommands: vi.fn() };
		await Reflect.apply(SessionTurnAgent.prototype.cancelSubmissionById, host, ['queued']);
		expect(host.cancelSubmission).toHaveBeenCalledWith('queued', 'Cancelled by user');
		expect(host.cancelWorkspaceCommands).not.toHaveBeenCalled();
	});

	it('ignores a response callback delivered after cancellation cleared the active turn', async () => {
		const host = { state: {}, getMessages: vi.fn(), eventQueue: [] };
		await Reflect.apply(SessionTurnAgent.prototype.onChatResponse, host, [{ requestId: 'submission-1', status: 'aborted' }]);
		expect(host.getMessages).not.toHaveBeenCalled();
	});

	it('leaves terminal status to the submission ledger when the stream callback reports an error', async () => {
		const host = {
			state: { activeTurn: { submissionId: 'submission-1' } },
			eventQueue: [],
			saveSnapshotChanges: async () => {},
			forwardEvents: async () => {},
			getMessages: vi.fn(),
			setState: vi.fn(),
		};
		await Reflect.apply(SessionTurnAgent.prototype.onChatResponse, host, [
			{ requestId: 'submission-1', status: 'error', error: 'Stream error' },
		]);
		expect(host.setState).not.toHaveBeenCalled();
		expect(host.getMessages).not.toHaveBeenCalled();
	});

	it('publishes terminal state before an empty snapshot can acquire the workspace mutation queue', async () => {
		const completeThinkTurn = vi.fn(async () => {});
		const cleanup = new Promise<void>(() => {});
		const host = {
			state: {
				activeSubmissionId: 'submission-1',
				activeTurn: { submissionId: 'submission-1' },
				activeSnapshot: { id: 'snapshot', directory: '/snapshot', savedPaths: [] },
				pendingCompletion: { submissionId: 'submission-1', history: [], status: 'aborted' },
			},
			getSnapshotContext: () => ({ id: 'snapshot', directory: '/snapshot', savedPaths: new Set<string>() }),
			forwardEvents: vi.fn(async () => {}),
			listSubmissions: async () => [],
			requireConfiguration: () => ({ sessionId: 'session' }),
			parentAgent: async () => ({ completeThinkTurn }),
			setState: vi.fn(),
			deleteEmptySnapshot: vi.fn(() => cleanup),
			ctx: { waitUntil: vi.fn() },
		};
		await Reflect.apply(Reflect.get(SessionTurnAgent.prototype, 'completePendingTurnInner'), host, []);
		expect(completeThinkTurn).toHaveBeenCalledWith('session', 'submission-1', [], 'aborted', undefined, []);
		expect(host.setState).toHaveBeenCalledWith(expect.objectContaining({ activeSubmissionId: undefined, pendingCompletion: undefined }));
		expect(host.deleteEmptySnapshot).toHaveBeenCalledOnce();
		expect(host.ctx.waitUntil).toHaveBeenCalledOnce();
	});

	it.each([false, true])('waits after a successful user question (invalid first call: %s)', async (invalidFirstCall) => {
		const sendEvent = createMockSendEvent();
		const tools = await createServerTools(sendEvent, createMockContext(), [], 'code');
		let modelCalls = 0;
		const model = new MockLanguageModelV3({
			doGenerate: async () => {
				modelCalls++;
				return {
					content: [
						{
							type: 'tool-call',
							toolCallId: `question-${modelCalls}`,
							toolName: 'user_question',
							input: JSON.stringify(invalidFirstCall && modelCalls === 1 ? {} : { question: 'Which color?', options: 'Red, Blue' }),
						},
					],
					finishReason: { unified: 'tool-calls', raw: undefined },
					usage: {
						inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
						outputTokens: { total: 1, text: 1, reasoning: 0 },
					},
					warnings: [],
				};
			},
		});

		const result = await generateText({ model, tools, prompt: 'Ask me to choose a color.', stopWhen: [stepCountIs(5), shouldWaitForUser] });

		expect(modelCalls).toBe(invalidFirstCall ? 2 : 1);
		expect(result.toolResults[0]?.toolName).toBe('user_question');
		expect(sendEvent.calls.filter(([type]) => type === 'user_question')).toEqual([
			['user_question', { question: 'Which color?', options: 'Red, Blue' }],
		]);
	});

	it('includes mode-specific tool instructions and project guidelines', async () => {
		const instructions = await buildSessionTurnInstructions('code', 'Use project conventions.');

		expect(instructions).toContain(CODE_MODE_SYSTEM_PROMPT);
		expect(instructions).toContain('Computer tools');
		expect(instructions).toContain('backend "auto"');
		expect(instructions).toContain('Full Worker projects resolve registered packages without a container');
		expect(instructions).toContain('single `codemode` snippet');
		expect(instructions).toContain('state.readdir');
		expect(instructions).toContain('## Project Guidelines (from AGENTS.md)\nUse project conventions.');
	});

	it('activates the submitted turn configuration from durable submission metadata', () => {
		const model = AI_MODELS[0].id;

		expect(
			parseActiveTurnConfiguration(
				{
					mode: 'plan',
					model,
					initiatorUserId: 'user-1',
					requestOriginContext: { appOrigin: 'https://example.com', contentOrigin: 'https://content.example.net' },
				},
				'submission-1',
			),
		).toEqual({
			submissionId: 'submission-1',
			mode: 'plan',
			model,
			initiatorUserId: 'user-1',
			requestOriginContext: { appOrigin: 'https://example.com', contentOrigin: 'https://content.example.net' },
		});
	});

	it('rejects missing or invalid durable submission metadata', () => {
		expect(parseActiveTurnConfiguration(undefined, 'submission-1')).toBeUndefined();
		expect(parseActiveTurnConfiguration({ mode: 'invalid', model: DEFAULT_AI_MODEL }, 'submission-1')).toBeUndefined();
		expect(parseActiveTurnConfiguration({ mode: 'code', model: 'invalid' }, 'submission-1')).toBeUndefined();
	});

	it('maps every terminal Think submission state to a parent session result', () => {
		expect(getTerminalSubmissionResult(submission('completed'))).toEqual({ status: 'completed' });
		expect(getTerminalSubmissionResult(submission('aborted', 'Cancelled by user'))).toEqual({
			status: 'aborted',
			error: 'Cancelled by user',
		});
		expect(getTerminalSubmissionResult(submission('error', 'Preparation failed'))).toEqual({
			status: 'error',
			error: 'Preparation failed',
		});
		expect(getTerminalSubmissionResult(submission('skipped'))).toEqual({
			status: 'error',
			error: 'The agent turn was skipped before it could run.',
		});
	});
});
