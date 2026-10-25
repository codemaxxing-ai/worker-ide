import { describe, expect, it, vi } from 'vitest';

import { SessionStreamState } from './session-stream-state';

import type { AgentSessionState } from '@shared/agent-state';

function createHarness() {
	let current: AgentSessionState = {
		sessionId: 'session',
		title: 'Test',
		status: 'running',
		messages: [],
		historyVersion: 0,
		statusText: undefined,
		error: undefined,
		contextTokensUsed: 0,
		pendingChanges: {},
		toolMetadata: {},
		toolErrors: {},
		debugLogId: undefined,
		stopRequested: false,
		pendingQuestion: undefined,
		needsContinuation: false,
		doomLoopMessage: undefined,
		subAgentActivities: {},
	};
	const recordToolCall = vi.fn();
	const stream = new SessionStreamState({
		getCurrentSession: () => current,
		updateSessionState: (_sessionId, patch) => {
			current = { ...current, ...patch };
		},
		readSession: async () => {},
		getSessionInitiatorUserId: () => {},
		sendPushNotification: vi.fn(),
		recordToolCall,
		recordTurnComplete: vi.fn(),
		recordUsage: vi.fn(),
	});
	return { stream, getCurrent: () => current, recordToolCall };
}

describe('streamed tool arguments', () => {
	it.each([false, true])('uses complete arguments without duplicating the tool (input start: %s)', async (started) => {
		const { stream, getCurrent, recordToolCall } = createHarness();
		if (started) {
			await stream.handleEvent('session', { type: 'tool-call-start', toolCallId: 'write-1', toolName: 'write' });
			await stream.handleEvent('session', { type: 'tool-call-args-delta', toolCallId: 'write-1', delta: '{"path":"/old' });
		}
		await stream.handleEvent('session', {
			type: 'tool-call-start',
			toolCallId: 'write-1',
			toolName: 'write',
			arguments: { path: '/app.tsx', content: 'hello' },
		});
		expect(getCurrent().messages[0]?.parts).toEqual([
			{ type: 'tool-call', toolCallId: 'write-1', toolName: 'write', arguments: { path: '/app.tsx', content: 'hello' } },
		]);
		expect(recordToolCall).toHaveBeenCalledOnce();
	});

	it('continues updating tool arguments after another user message is queued', async () => {
		const { stream, getCurrent } = createHarness();
		await stream.handleEvent('session', { type: 'tool-call-start', toolCallId: 'write-1', toolName: 'write' });
		await stream.handleEvent('session', { type: 'tool-call-args-delta', toolCallId: 'write-1', delta: '{"path":"/' });
		getCurrent().messages.push({ id: 'queued', role: 'user', parts: [{ type: 'text', content: 'Next task' }], createdAt: 1 });
		await stream.handleEvent('session', { type: 'tool-call-args-delta', toolCallId: 'write-1', delta: 'app.tsx"}' });
		expect(getCurrent().messages[0]?.parts[0]).toMatchObject({ arguments: { path: '/app.tsx' } });
		expect(getCurrent().messages[1]?.id).toBe('queued');
	});

	it('marks sub-agent result errors as failed activity', async () => {
		const { stream, getCurrent } = createHarness();
		await stream.handleEvent('session', {
			type: 'sub-agent-activity',
			parentToolCallId: 'parent',
			activity: { kind: 'tool-metadata', toolName: 'write', title: 'Error', metadata: { error: 'Protected file' } },
		});
		expect(getCurrent().subAgentActivities.parent?.tools[0]).toMatchObject({ isError: true, metadata: { error: 'Protected file' } });
	});

	it('exposes partial arguments before execution and preserves the final result', async () => {
		const { stream, getCurrent } = createHarness();
		await stream.handleEvent('session', { type: 'tool-call-start', toolCallId: 'write-1', toolName: 'write' });
		await stream.handleEvent('session', {
			type: 'tool-call-args-delta',
			toolCallId: 'write-1',
			delta: '{"path":"/src/app.tsx","content":"hel',
		});
		expect(getCurrent().messages[0]?.parts[0]).toMatchObject({ arguments: { path: '/src/app.tsx', content: 'hel' } });
		await stream.handleEvent('session', { type: 'tool-call-args-delta', toolCallId: 'write-1', delta: 'lo"}' });
		await stream.handleEvent('session', { type: 'tool-call-end', toolCallId: 'write-1', toolName: 'write', result: 'saved' });
		expect(getCurrent().messages[0]?.parts).toEqual([
			expect.objectContaining({ arguments: { path: '/src/app.tsx', content: 'hello' } }),
			expect.objectContaining({ type: 'tool-result', result: 'saved' }),
		]);
	});

	it('keeps interleaved arguments separate and ignores events for other sessions', async () => {
		const { stream, getCurrent } = createHarness();
		for (const toolCallId of ['first', 'second']) {
			await stream.handleEvent('session', { type: 'tool-call-start', toolCallId, toolName: 'read' });
			await stream.handleEvent('session', { type: 'tool-call-args-delta', toolCallId, delta: '{"path":"/' });
		}
		await stream.handleEvent('session', { type: 'tool-call-args-delta', toolCallId: 'second', delta: 'second"}' });
		await stream.handleEvent('other', { type: 'tool-call-args-delta', toolCallId: 'first', delta: 'wrong"}' });
		await stream.handleEvent('session', { type: 'tool-call-args-delta', toolCallId: 'first', delta: 'first"}' });
		expect(getCurrent().messages[0]?.parts).toEqual([
			expect.objectContaining({ arguments: { path: '/first' } }),
			expect.objectContaining({ arguments: { path: '/second' } }),
		]);
	});
});
