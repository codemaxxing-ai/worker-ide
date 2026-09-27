import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { DEFAULT_AI_MODEL } from '@shared/constants';

import type { AgentRunner } from './agent-runner';
import type { ChatMessage } from '@shared/types';

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
