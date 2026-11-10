import { generateText, isStepCount } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';

import { initialChatState } from '@shared/agent-chat';
import { CODE_MODE_SYSTEM_PROMPT } from '@shared/constants';

import { SessionTurnAgent, buildSessionTurnInstructions, getTerminalSubmissionResult, shouldWaitForUser } from './session-turn-agent';
import { createAgentToolCatalog } from '../services/agent/tools';
import { createMockContext, createMockSendEvent } from '../services/agent/tools/test-helpers';

import type { ThinkSubmissionInspection } from '@cloudflare/think';

function invoke(name: string, host: object, ...parameters: unknown[]) {
	const method: unknown = Reflect.get(SessionTurnAgent.prototype, name);
	if (typeof method !== 'function') throw new Error(`Missing method ${name}`);
	return Reflect.apply(method, host, parameters);
}
function setup() {
	const controller = new AbortController();
	const parent = { completeSessionOperation: vi.fn(async () => {}) };
	const state = { ...initialChatState(), activeSubmissionId: 'active', pendingChanges: {}, finalizations: {}, revision: 0 };
	const host = {
		state,
		get execution(): typeof state {
			return host.state;
		},
		controller,
		configuration: { sessionId: 'session' },
		update: (patch: object) => {
			host.state = { ...host.state, ...patch };
		},
		initializeTurn: (id: string, userId?: string) => invoke('initializeTurn', host, id, userId),
		flushToolEvents: vi.fn(async () => {}),
		refreshSubmissionState: vi.fn(async () => {}),
		queue: vi.fn(async () => {}),
		listSubmissions: vi.fn(async (): Promise<ThinkSubmissionInspection[]> => []),
		cancelSubmission: vi.fn(async (_id: string, _reason: string) => {}),
		cancelAllChats: vi.fn(),
		cancelChat: vi.fn(),
		prepareFinalizationChanges: vi.fn(async () => {}),
		parentAgent: vi.fn(async () => parent),
		filesystem: {
			settleAgentTurn: vi.fn(async () => {}),
			cancelComputerSessionExecutions: vi.fn(async () => {}),
			getComputerExecutions: vi.fn(async (): Promise<Array<{ status: string }>> => []),
		},
		ctx: {
			waitUntil: vi.fn(),
			storage: {
				kv: { get: vi.fn((_key: string): unknown => undefined), put: vi.fn((_key: string, _value: unknown) => {}), delete: vi.fn() },
			},
		},
	};
	return { host, parent };
}
function submission(status: ThinkSubmissionInspection['status'], id = 'active'): ThinkSubmissionInspection {
	return { submissionId: id, status, createdAt: 1 };
}
describe('Think turn and finalization boundaries', () => {
	it.each(['validation', 'sdk-admission'])('drains native requests that yield during %s before facet deletion', async (stage) => {
		const storedMessage = { id: 'user', role: 'user', parts: [{ type: 'text', text: 'Request' }] };
		const validation = Promise.withResolvers<typeof storedMessage>();
		const nativeAdmission = Promise.withResolvers<void>();
		const flags = new Map<string, unknown>();
		const native = vi.fn(async (_connection: unknown, _message: unknown) => nativeAdmission.promise);
		const host = {
			onMessage: native,
			nativeRequests: new Set<Promise<void>>(),
			admissionTail: Promise.resolve(),
			session: { getMessage: vi.fn(async () => validation.promise) },
			ctx: { storage: { kv: { get: (key: string) => flags.get(key), put: (key: string, value: unknown) => flags.set(key, value) } } },
			waitUntilStable: vi.fn(async () => true),
		};
		const connection = { close: vi.fn() };
		invoke('configureChatTransport', host);
		const handling = host.onMessage(
			connection,
			JSON.stringify({
				type: 'cf_agent_use_chat_request',
				id: 'native-request',
				init: { method: 'POST', body: JSON.stringify({ trigger: 'regenerate-message', messages: [{ id: 'user' }] }) },
			}),
		);
		if (stage === 'sdk-admission') {
			validation.resolve(storedMessage);
			await vi.waitFor(() => expect(native).toHaveBeenCalledOnce());
		}
		await invoke('closeAdmissions', host);
		if (stage === 'validation') {
			await invoke('waitForCompletion', host);
			validation.resolve(storedMessage);
			await handling;
			expect(native).not.toHaveBeenCalled();
			expect(connection.close).toHaveBeenCalledWith(1008, 'Session is being deleted');
		} else {
			await expect(invoke('waitForCompletion', host)).rejects.toThrow('still stopping');
			nativeAdmission.resolve();
			await handling;
			await invoke('waitForCompletion', host);
		}
		expect(host.nativeRequests.size).toBe(0);
	});
	it('resets turn-scoped guard, log and tool state for a new operation, retaining them during recovery', () => {
		const { host } = setup();
		host.update({
			failureState: { submissionId: 'previous', count: 3, seen: ['failure'], message: 'Stopped after repeated failures' },
			activeDebugLog: { id: 'old-log' },
			activeSnapshot: { id: 'old-snapshot' },
			pendingChanges: { '/source.ts': {} },
			toolMetadata: { previous: {} },
			toolErrors: { previous: {} },
			error: 'Previous failure',
		});
		invoke('initializeTurn', host, 'native-regeneration', 'author');
		expect(host.state).toMatchObject({
			activeSubmissionId: 'native-regeneration',
			activeUserId: 'author',
			failureState: { submissionId: 'native-regeneration', count: 0, seen: [] },
			pendingChanges: {},
			toolMetadata: {},
			toolErrors: {},
		});
		expect(host.state).toHaveProperty('activeDebugLog');
		expect(host.state).toHaveProperty('activeSnapshot');
		expect(host.state).toHaveProperty('error');
		host.update({ activeDebugLog: { id: 'new-log' }, failureState: { submissionId: 'native-regeneration', count: 1, seen: [] } });
		const recovering = host.state;
		invoke('initializeTurn', host, 'native-regeneration', 'author');
		expect(host.state).toBe(recovering);
	});
	it('durably closes admissions before waiting for an in-flight ledger write', async () => {
		const { host } = setup();
		const admission = Promise.withResolvers<void>();
		const admissionsClosed = new Map<string, boolean>();
		host.ctx.storage.kv.get.mockImplementation((key: string) => admissionsClosed.get(key));
		host.ctx.storage.kv.put.mockImplementation((key: string, value: unknown) => {
			admissionsClosed.set(key, value === true);
		});
		const admitting = { ...host, admissionTail: admission.promise, assertAdmissionsOpen: () => invoke('assertAdmissionsOpen', host) };
		const closing = invoke('closeAdmissions', admitting);
		expect(admissionsClosed.get('admissions-closed')).toBe(true);
		const queued = invoke('withAdmission', admitting, vi.fn());
		admission.resolve();
		await expect(queued).rejects.toThrow('being deleted');
		await closing;
	});
	it('cancels queued messages before the running submission without waiting for workspace synchronization', async () => {
		const { host } = setup();
		host.listSubmissions.mockResolvedValue([submission('running'), submission('pending', 'queued')]);
		const workspace = Promise.withResolvers<void>();
		host.filesystem.cancelComputerSessionExecutions.mockReturnValue(workspace.promise);
		await invoke('cancelActiveSubmissions', host);
		expect(host.controller.signal.aborted).toBe(true);
		expect(host.cancelSubmission.mock.calls.map((call) => call[0])).toEqual(['queued', 'active']);
		expect(host.ctx.waitUntil).toHaveBeenCalledOnce();
		workspace.resolve();
	});
	it.each(['completed', 'error', 'aborted', 'skipped'])(
		'persists a %s terminal outcome before scheduling its finalization',
		async (status) => {
			const { host } = setup();
			await invoke('onSubmissionStatus', host, { ...submission('completed'), status });
			expect(host.state.finalizations).toHaveProperty('active');
			expect(host.state.status).toBe(status === 'skipped' ? 'aborted' : status);
			expect(host.queue).toHaveBeenCalledWith('flushFinalizations', {});
		},
	);
	it('does not finalize the active turn when a queued submission is withdrawn', async () => {
		const { host } = setup();
		await invoke('onSubmissionStatus', host, submission('aborted', 'queued'));
		expect(host.state.activeSubmissionId).toBe('active');
		expect(host.state.finalizations).toHaveProperty('queued');
		expect(host.queue).toHaveBeenCalledWith('flushFinalizations', {});
	});
	it('lets the submission ledger settle programmatic turns even if a response callback differs', async () => {
		const { host } = setup();
		await invoke('onChatResponse', host, {
			requestId: 'active',
			status: 'error',
			error: 'Stream stopped',
			message: { id: 'reply', role: 'assistant', parts: [] },
			continuation: false,
		});
		expect(host.state.finalizations).toEqual({});
		await invoke('onSubmissionStatus', host, submission('aborted'));
		expect(host.state.status).toBe('aborted');
	});
	it('retains failed outbox delivery and removes it only after successful replay', async () => {
		const { host, parent } = setup();
		host.update({ finalizations: { active: { submissionId: 'active', status: 'completed', changesPrepared: true, changes: {} } } });
		parent.completeSessionOperation.mockRejectedValueOnce(new Error('Delivery unavailable'));
		await expect(invoke('deliverFinalizations', host)).rejects.toThrow('Delivery unavailable');
		expect(host.state.finalizations).toHaveProperty('active');
		await invoke('deliverFinalizations', host);
		expect(host.state.finalizations).toEqual({});
		await invoke('deliverFinalizations', host);
		expect(parent.completeSessionOperation).toHaveBeenCalledTimes(2);
	});
	it('preserves a prepared outbox record when a terminal hook is redelivered during a later turn', async () => {
		const { host } = setup();
		const finalization = {
			submissionId: 'previous',
			status: 'completed',
			changesPrepared: true,
			changes: { '/source.ts': { path: '/source.ts', action: 'edit', beforeContent: 'before', afterContent: 'after' } },
		};
		host.update({ finalizations: { previous: finalization } });
		await invoke('onSubmissionStatus', host, submission('completed', 'previous'));
		expect(host.state.finalizations).toEqual({ previous: finalization });
		expect(host.state.activeSubmissionId).toBe('active');
		expect(host.queue).toHaveBeenCalledWith('flushFinalizations', {});
	});
	it('resumes safe reads but declines recovery after a mutation intent or uncertain execution', async () => {
		const { host } = setup();
		expect(await invoke('onChatRecovery', host, {})).toEqual({ continue: true });
		host.ctx.storage.kv.get.mockImplementation((key: string) => key.startsWith('mutation:'));
		expect(await invoke('onChatRecovery', host, {})).toEqual({ continue: false });
		host.ctx.storage.kv.get.mockReturnValue();
		host.filesystem.getComputerExecutions.mockResolvedValue([{ status: 'synchronization-pending' }]);
		expect(await invoke('onChatRecovery', host, {})).toEqual({ continue: false });
	});
	it('resumes inference after a settled mutation but stops when durable synchronization is uncertain', async () => {
		const { host } = setup();
		host.ctx.storage.kv.get.mockImplementation((key: string) => key.startsWith('mutation:'));
		const context = { recoveryKind: 'continue', partialParts: [{ type: 'tool-write', state: 'output-available' }] };
		expect(await invoke('onChatRecovery', host, context)).toEqual({ continue: true });
		expect(host.filesystem.settleAgentTurn).toHaveBeenCalledWith('session');
		host.filesystem.settleAgentTurn.mockRejectedValue(new Error('Uncertain execution'));
		expect(await invoke('onChatRecovery', host, context)).toEqual({ continue: false });
		expect(await invoke('onChatRecovery', host, { ...context, partialParts: [{ type: 'tool-write', state: 'input-available' }] })).toEqual({
			continue: false,
		});
	});
	it('rejects client changes to the authoritative chat configuration', () => {
		expect(() => invoke('validateStateChange', {}, {}, { id: 'browser' })).toThrow('server-owned');
	});
	it('maps cancellation and skipped submissions without fabricating provider errors', () => {
		expect(getTerminalSubmissionResult(submission('aborted'))).toEqual({ status: 'aborted' });
		expect(getTerminalSubmissionResult(submission('skipped'))).toEqual({ status: 'aborted' });
	});
	it('uses current tool names and retains project-specific instructions', async () => {
		const instructions = await buildSessionTurnInstructions('code', 'Use project conventions.');
		expect(instructions).toContain(CODE_MODE_SYSTEM_PROMPT);
		expect(instructions).toContain('Use project conventions.');
		expect(instructions).not.toContain('state.readFile');
	});
	it.each([false, true])('waits after a successful user question (invalid first call: %s)', async (invalidFirstCall) => {
		const sendEvent = createMockSendEvent();
		const catalog = await createAgentToolCatalog(sendEvent, createMockContext(), [], 'code');
		const tools = { ...catalog.nestedTools, ...catalog.directTools };
		let modelCalls = 0;
		const model = new MockLanguageModelV4({
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

		const result = await generateText({ model, tools, prompt: 'Ask me to choose a color.', stopWhen: [isStepCount(5), shouldWaitForUser] });

		expect(modelCalls).toBe(invalidFirstCall ? 2 : 1);
		expect(result.toolResults[0]?.toolName).toBe('user_question');
		expect(sendEvent.calls.filter(([type]) => type === 'user_question')).toEqual([
			['user_question', { question: 'Which color?', options: 'Red, Blue' }],
		]);
	});
});
