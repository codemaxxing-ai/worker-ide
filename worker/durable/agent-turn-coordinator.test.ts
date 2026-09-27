import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_AI_MODEL } from '@shared/constants';

import { AgentTurnCoordinator } from './agent-turn-coordinator';

import type { TurnExecutionConfiguration } from './session-turn-agent';
import type { AgentSessionState } from '@shared/agent-state';
import type { ChatMessage } from '@shared/types';

function userMessage(id: string, state: 'queued' | 'committed', authorUserId?: string): ChatMessage {
	return {
		id,
		role: 'user',
		parts: [{ type: 'text', content: id }],
		createdAt: 1,
		authorUserId,
		metadata: { request: { mode: 'code', model: DEFAULT_AI_MODEL, state } },
	};
}

function sessionState(messages: ChatMessage[] = []): AgentSessionState {
	return {
		sessionId: 'session-1',
		title: 'Test session',
		status: 'running',
		messages,
		historyVersion: 0,
		statusText: 'Working...',
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
}

function createHarness(messages: ChatMessage[] = []) {
	let current = sessionState(messages);
	const calls: string[] = [];
	const turnAgent = {
		submitTurn: vi.fn(async (message: ChatMessage) => {
			calls.push(`submit:${message.id}`);
			return { accepted: true, status: 'pending', submissionId: message.id };
		}),
		replaceHistory: vi.fn(async (_messages: ChatMessage[]) => {
			calls.push('replace-history');
		}),
		cancelSubmissionById: vi.fn(async (_submissionId: string) => {
			calls.push('cancel-queued');
		}),
		cancelActiveSubmissions: vi.fn(async () => {
			calls.push('cancel-active');
		}),
	};
	const coordinator = new AgentTurnCoordinator({
		getCurrentSession: () => current,
		updateSessionState: (_sessionId, patch) => {
			current = { ...current, ...patch };
			calls.push('update-state');
		},
		getConfiguredTurnAgent: async () => turnAgent,
		getTurnAgent: async () => turnAgent,
		getSessionStore: () => ({
			read: async () => {},
			persistHistory: async () => {},
			writeMetadata: () => {},
		}),
		getReviewQueue: () => ({ syncSessionPendingChanges: () => {} }),
		refreshReviewState: () => {},
		refreshSessionsList: async () => {},
		hasCompletion: () => false,
		markCompletion: () => {},
		pruneOldSessions: async () => {},
	});
	return { coordinator, currentSession: () => current, turnAgent, calls };
}

const turnConfiguration: TurnExecutionConfiguration = { mode: 'code', model: DEFAULT_AI_MODEL };

describe('agent turn coordination', () => {
	it('queues a second message without interrupting the running turn', async () => {
		const firstMessage = userMessage('first', 'committed');
		const queuedMessage = userMessage('second', 'queued');
		const harness = createHarness([firstMessage]);

		const result = await harness.coordinator.submitMessage(
			'session-1',
			queuedMessage,
			DEFAULT_AI_MODEL,
			turnConfiguration,
			harness.currentSession(),
		);

		expect(result).toEqual({ sessionId: 'session-1', queued: true, started: false });
		expect(harness.currentSession().messages).toEqual([firstMessage, queuedMessage]);
		expect(harness.currentSession().statusText).toBe('Working...');
		expect(harness.turnAgent.submitTurn).toHaveBeenCalledWith(queuedMessage, turnConfiguration);
	});

	it('only lets the author remove a queued message', async () => {
		const queuedMessage = userMessage('queued', 'queued', 'author');
		const harness = createHarness([queuedMessage]);

		await expect(harness.coordinator.removeQueuedMessage('session-1', 'queued', 'someone-else')).rejects.toThrow(
			'Not authorized to remove this queued message.',
		);
		expect(harness.turnAgent.cancelSubmissionById).not.toHaveBeenCalled();
		await expect(harness.coordinator.removeQueuedMessage('session-1', 'queued', 'author')).resolves.toEqual({ removed: true });
		expect(harness.turnAgent.cancelSubmissionById).toHaveBeenCalledWith('queued');
		expect(harness.currentSession().messages).toEqual([]);
	});

	it('marks a run as stopping before asking Think to cancel it', async () => {
		const harness = createHarness();
		await harness.coordinator.abortRun('session-1');

		expect(harness.currentSession().stopRequested).toBe(true);
		expect(harness.currentSession().statusText).toBe('Stopping...');
		expect(harness.calls).toEqual(['update-state', 'cancel-active']);
	});

	it('replaces retry history before submitting the restarted turn', async () => {
		const harness = createHarness();
		const previousMessage = userMessage('previous', 'committed');
		const latestMessage = userMessage('latest', 'committed');

		await expect(
			harness.coordinator.startRun('session-1', [previousMessage], latestMessage, DEFAULT_AI_MODEL, turnConfiguration),
		).resolves.toEqual({ sessionId: 'session-1' });
		expect(harness.calls).toEqual(['replace-history', 'submit:latest', 'update-state']);
		expect(harness.currentSession().messages).toEqual([latestMessage]);
	});

	it('serializes mutations of the same session even when the first fails', async () => {
		const harness = createHarness();
		let beginFirst: (() => void) | undefined;
		const firstStarted = new Promise<void>((resolve) => {
			beginFirst = resolve;
		});
		let releaseFirst: (() => void) | undefined;
		const firstBlocked = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const calls: string[] = [];
		const first = harness.coordinator.withSessionMutationLock('session-1', async () => {
			calls.push('first-start');
			beginFirst?.();
			await firstBlocked;
			calls.push('first-end');
			throw new Error('first failed');
		});
		await firstStarted;
		const second = harness.coordinator.withSessionMutationLock('session-1', async () => {
			calls.push('second-start');
		});
		await Promise.resolve();
		expect(calls).toEqual(['first-start']);
		releaseFirst?.();
		await expect(first).rejects.toThrow('first failed');
		await second;
		expect(calls).toEqual(['first-start', 'first-end', 'second-start']);
	});
});
