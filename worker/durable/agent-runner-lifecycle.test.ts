import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_AI_MODEL } from '@shared/constants';

import type { AgentRunner } from './agent-runner';
import type { AiSession, ChatMessage } from '@shared/types';

function getAgentStub(name: string): DurableObjectStub<AgentRunner> {
	const namespace = env.AgentRunner;
	return namespace.getByName(name);
}

async function createTestAgent(name: string, sessionId: string): Promise<DurableObjectStub<AgentRunner>> {
	await env.DB.exec('CREATE TABLE IF NOT EXISTS project (id TEXT PRIMARY KEY, organization_id TEXT, deleted_at TEXT, banned_at TEXT)');
	const stub = getAgentStub(name);
	// The test workerd predates native Durable Object name propagation.
	await stub.setName(name);
	await runInDurableObject(stub, (_instance, state) => {
		state.storage.sql.exec(
			'INSERT INTO assistant_sessions (id, name, parent_session_id, model, source) VALUES (?, ?, NULL, ?, ?)',
			sessionId,
			'Test session',
			DEFAULT_AI_MODEL,
			'code',
		);
	});
	return stub;
}

describe('agent runner turn completion', () => {
	it('restores a saved debug-log ID after reopening and ignores late writes from older runs', async () => {
		const sessionId = 'debug-log-session';
		const stub = await createTestAgent('agent:debug-log-persistence', sessionId);
		await stub.loadSession(sessionId);
		await stub.setSessionDebugLogId(sessionId, `${sessionId}-200`);
		await stub.setSessionDebugLogId(sessionId, `${sessionId}-100`);
		await stub.clearCurrentSession();
		await stub.loadSession(sessionId);
		await runInDurableObject(stub, (instance) => {
			expect(instance.state.currentSession?.debugLogId).toBe(`${sessionId}-200`);
		});
	});

	it('persists a background session log without changing the selected chat', async () => {
		const stub = await createTestAgent('agent:background-debug-log', 'background');
		await stub.setSessionDebugLogId('background', 'background-200');
		await runInDurableObject(stub, (instance) => {
			expect(instance.state.currentSession).toBeUndefined();
		});
		await stub.loadSession('background');
		await runInDurableObject(stub, (instance) => {
			expect(instance.state.currentSession?.debugLogId).toBe('background-200');
		});
	});
	it('flushes pending text before completion instead of appending it again afterward', async () => {
		const stub = await createTestAgent('agent:buffered-completion-test', 'buffered-session');
		await stub.loadSession('buffered-session');
		await stub.receiveThinkEvents('buffered-session', [{ type: 'text-delta', delta: 'Buffered response' }]);
		const history: ChatMessage[] = [
			{ id: 'request', role: 'user', parts: [{ type: 'text', content: 'Hello' }] },
			{ id: 'response', role: 'assistant', parts: [{ type: 'text', content: 'Buffered response' }] },
		];
		await stub.completeThinkTurn('buffered-session', 'request', history, 'completed');
		await new Promise((resolve) => setTimeout(resolve, 75));
		await runInDurableObject(stub, (instance) => {
			expect(instance.state.currentSession?.messages).toEqual([]);
			expect(instance.state.currentSession?.status).toBe('completed');
		});
		using session = await stub.readSession('buffered-session');
		expect(session?.history).toEqual(history);
	});

	it.each([true, false])('persists rich tool results and errors through completion (selected: %s)', async (selected) => {
		const sessionId = `tool-session-${selected}`;
		const stub = await createTestAgent(`agent:tool-metadata-${selected}`, sessionId);
		if (selected) await stub.loadSession(sessionId);
		const todos = [{ id: 'task-1', content: 'Fix tools', status: 'in_progress', priority: 'high' }];
		await stub.receiveThinkEvents(sessionId, [
			{ type: 'tool-result', toolCallId: 'todos-1', toolName: 'todos_update', title: 'todos', metadata: { todos } },
		]);
		await stub.receiveThinkEvents(sessionId, [
			{
				type: 'tool-result',
				toolCallId: 'plan-1',
				toolName: 'plan_update',
				title: 'plan',
				metadata: { planFilePath: '.agent/plans/test.md' },
			},
			{ type: 'tool-error', toolCallId: 'lint-1', toolName: 'lint_check', errorCode: 'FILE_NOT_FOUND', errorMessage: 'Missing file' },
		]);
		if (selected) {
			await runInDurableObject(stub, (instance) => {
				expect(instance.state.currentSession?.toolErrors['lint-1']?.errorCode).toBe('FILE_NOT_FOUND');
			});
		}
		await stub.completeThinkTurn(
			sessionId,
			'request',
			[{ id: 'request', role: 'user', parts: [{ type: 'text', content: 'Fix tools' }] }],
			'completed',
		);

		using snapshot = await stub.readSession(sessionId);
		expect(snapshot?.toolMetadata?.['todos-1']?.metadata).toEqual({ todos });
		expect(snapshot?.toolMetadata?.['plan-1']?.metadata).toEqual({ planFilePath: '.agent/plans/test.md' });
		expect(snapshot?.toolErrors?.['lint-1']).toMatchObject({ errorCode: 'FILE_NOT_FOUND', toolName: 'lint_check' });

		await stub.loadSession(sessionId);
		await runInDurableObject(stub, (instance) => {
			expect(instance.state.currentSession?.toolMetadata['todos-1']?.metadata).toEqual({ todos });
			expect(instance.state.currentSession?.toolErrors['lint-1']?.errorCode).toBe('FILE_NOT_FOUND');
		});
	});

	it('restores an unanswered question when reloading its session and clears it for the answer', async () => {
		const stub = await createTestAgent('agent:question-reload-test', 'question-session');
		const history: ChatMessage[] = [
			{ id: 'request', role: 'user', parts: [{ type: 'text', content: 'Choose a color' }] },
			{
				id: 'question',
				role: 'assistant',
				parts: [
					{
						type: 'tool-call',
						toolCallId: 'question-1',
						toolName: 'user_question',
						arguments: { question: 'Which color?', options: 'Red, Blue' },
					},
					{ type: 'tool-result', toolCallId: 'question-1', toolName: 'user_question', result: 'Question displayed' },
				],
			},
		];
		await stub.completeThinkTurn('question-session', 'request', history, 'completed');
		await stub.loadSession('question-session');
		await runInDurableObject(stub, (instance) => {
			expect(instance.state.currentSession?.pendingQuestion).toEqual({ question: 'Which color?', options: 'Red, Blue' });
			expect(instance.state.currentSession?.status).toBe('completed');
		});

		await stub.beginThinkTurn('question-session', 'answer');
		await runInDurableObject(stub, (instance) => {
			expect(instance.state.currentSession?.pendingQuestion).toBeUndefined();
		});
		await stub.completeThinkTurn(
			'question-session',
			'answer',
			[...history, { id: 'answer', role: 'user', parts: [{ type: 'text', content: 'Red' }] }],
			'completed',
		);
		await stub.loadSession('question-session');
		await runInDurableObject(stub, (instance) => {
			expect(instance.state.currentSession?.pendingQuestion).toBeUndefined();
		});
	});

	it('reads another session history without changing the selected session or live messages', async () => {
		const stub = await createTestAgent('agent:history-read-test', 'selected');
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec("INSERT INTO assistant_sessions (id, name) VALUES ('other', 'Other session')");
		});
		const history: ChatMessage[] = [{ id: 'saved', role: 'user', parts: [{ type: 'text', content: 'Other context' }] }];
		await stub.completeThinkTurn('other', 'saved', history, 'completed');
		await stub.loadSession('selected');
		await runInDurableObject(stub, (instance) => {
			const currentSession = instance.state.currentSession;
			if (!currentSession) throw new Error('Expected a selected session');
			instance.setState({
				...instance.state,
				currentSession: { ...currentSession, status: 'running', messages: [{ id: 'live', role: 'assistant', parts: [] }] },
			});
		});

		using snapshot = await stub.readSession('other');
		expect(snapshot?.history).toEqual(history);
		await stub.readSession('selected');
		await runInDurableObject(stub, (instance) => {
			expect(instance.state.currentSession?.sessionId).toBe('selected');
			expect(instance.state.currentSession?.status).toBe('running');
			expect(instance.state.currentSession?.messages).toEqual([{ id: 'live', role: 'assistant', parts: [] }]);
		});
	});

	it('keeps the newer selection when an earlier load finishes last', async () => {
		const stub = await createTestAgent('agent:selection-order-test', 'first');
		await runInDurableObject(stub, async (instance) => {
			const firstRead = Promise.withResolvers<AiSession | undefined>();
			const readSession = vi.spyOn(instance, 'readSession').mockImplementation(async (sessionId) => {
				if (sessionId === 'first') return firstRead.promise;
				return { id: sessionId, title: 'Second', createdAt: 2, history: [] };
			});
			const firstLoad = instance.loadSession('first');
			await instance.loadSession('second');
			firstRead.resolve({ id: 'first', title: 'First', createdAt: 1, history: [] });
			await firstLoad;
			readSession.mockRestore();

			expect(instance.state.currentSession?.sessionId).toBe('second');
		});
	});

	it('does not restore a delayed selection after starting a new session', async () => {
		const stub = await createTestAgent('agent:selection-clear-test', 'first');
		await runInDurableObject(stub, async (instance) => {
			const pendingRead = Promise.withResolvers<AiSession | undefined>();
			const readSession = vi.spyOn(instance, 'readSession').mockReturnValue(pendingRead.promise);
			const pendingLoad = instance.loadSession('first');
			await instance.clearCurrentSession();
			pendingRead.resolve({ id: 'first', title: 'First', createdAt: 1, history: [] });
			await pendingLoad;
			readSession.mockRestore();

			expect(instance.state.currentSession).toBeUndefined();
		});
	});

	it('persists a completed turn once when the child replays its completion', async () => {
		const stub = await createTestAgent('agent:turn-completion-test', 'session-1');

		const history: ChatMessage[] = [
			{ id: 'submission-1', role: 'user', parts: [{ type: 'text', content: 'Fix the bug' }], createdAt: 1 },
			{ id: 'reply-1', role: 'assistant', parts: [{ type: 'text', content: 'Done' }], createdAt: 2 },
		];
		await stub.completeThinkTurn('session-1', 'submission-1', history, 'completed');
		// The child may replay a pending completion after its parent has restarted.
		await runInDurableObject(stub, (_instance, state) => {
			state.abort('simulated eviction');
		}).catch(() => {});
		const recoveredStub = getAgentStub('agent:turn-completion-test');
		await recoveredStub.setName('agent:turn-completion-test');
		await recoveredStub.completeThinkTurn('session-1', 'submission-1', history, 'completed');

		using session = await recoveredStub.loadSession('session-1');
		expect(session?.history).toEqual(history);
		expect(session?.status).toBe('completed');
		await runInDurableObject(recoveredStub, (_instance, state) => {
			const rows = state.storage.sql.exec("SELECT submission_id FROM think_turn_completions WHERE session_id = 'session-1'").toArray();
			expect(rows).toHaveLength(1);
		});
	});

	it('keeps queued follow-ups live while persisting the completed turn', async () => {
		const stub = await createTestAgent('agent:queued-completion-test', 'session-2');
		await stub.loadSession('session-2');
		const runningMessage: ChatMessage = {
			id: 'submission-1',
			role: 'user',
			parts: [{ type: 'text', content: 'First' }],
			createdAt: 1,
			metadata: { request: { mode: 'code', model: DEFAULT_AI_MODEL, state: 'committed' } },
		};
		const queuedMessage: ChatMessage = {
			id: 'submission-2',
			role: 'user',
			parts: [{ type: 'text', content: 'Second' }],
			createdAt: 2,
			metadata: { request: { mode: 'code', model: DEFAULT_AI_MODEL, state: 'queued' } },
		};
		await runInDurableObject(stub, (instance) => {
			const currentSession = instance.state.currentSession;
			if (!currentSession) throw new Error('Expected a loaded session');
			instance.setState({
				...instance.state,
				currentSession: { ...currentSession, status: 'running', messages: [runningMessage, queuedMessage] },
			});
		});

		const reply: ChatMessage = { id: 'reply-1', role: 'assistant', parts: [{ type: 'text', content: 'Done' }], createdAt: 3 };
		await stub.completeThinkTurn('session-2', 'submission-1', [runningMessage, reply], 'completed', undefined, [
			{ submissionId: 'submission-2', status: 'pending' },
		]);

		using persistedSession = await stub.loadSession('session-2');
		expect(persistedSession?.history).toEqual([runningMessage, reply]);
		expect(persistedSession?.status).toBe('running');
		await runInDurableObject(stub, (instance) => {
			expect(instance.state.currentSession?.messages).toEqual([queuedMessage]);
			expect(instance.state.currentSession?.historyVersion).toBe(1);
			expect(instance.state.currentSession?.status).toBe('running');
		});

		await stub.beginThinkTurn('session-2', 'submission-2');
		await runInDurableObject(stub, (instance) => {
			expect(instance.state.currentSession?.messages[0]?.metadata?.request?.state).toBe('committed');
		});
	});

	it('does not replace live streaming messages when a running session is loaded', async () => {
		const stub = await createTestAgent('agent:live-load-test', 'session-3');
		await stub.loadSession('session-3');
		const liveMessage: ChatMessage = {
			id: 'streaming-reply',
			role: 'assistant',
			parts: [{ type: 'text', content: 'Partial response' }],
			createdAt: 2,
		};
		await runInDurableObject(stub, (instance) => {
			const currentSession = instance.state.currentSession;
			if (!currentSession) throw new Error('Expected a loaded session');
			instance.setState({
				...instance.state,
				currentSession: { ...currentSession, status: 'running', messages: [liveMessage], historyVersion: 3 },
			});
		});

		using staleSession = await stub.loadSession('session-3');
		expect(staleSession?.history).toEqual([]);
		await runInDurableObject(stub, (instance) => {
			expect(instance.state.currentSession?.messages).toEqual([liveMessage]);
			expect(instance.state.currentSession?.historyVersion).toBe(3);
		});
	});
});
