import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getActiveSessionId, setActiveSessionId } from '@/lib/project-storage';
import { useStore } from '@/lib/store';

import { useAgentSessions } from './use-agent-sessions';
import { createUnavailableAgentRunnerStub } from '../lib/agent-stub';

import type { AgentRuntimeHandle } from '../components/agent-runtime-context';
import type { AgentState, AgentSessionState } from '@shared/agent-state';
import type { AiSession, PendingFileChange, ReviewEntry } from '@shared/types';

function createPendingChange(path: string, sessionId: string, reviewId?: string): PendingFileChange {
	return {
		path,
		action: 'create',
		beforeContent: undefined,
		afterContent: `content:${path}:${sessionId}`,
		snapshotId: `${sessionId}-snapshot`,
		status: 'pending',
		hunkStatuses: ['pending'],
		hunkSessionIds: [[sessionId]],
		sessionId,
		sessionIds: [sessionId],
		reviewId,
	};
}

function createReviewEntry(path: string, sessionId: string, sessionIds = [sessionId], hunkSessionIds = [[sessionId]]): ReviewEntry {
	return {
		id: `${path}:${sessionId}`,
		path,
		action: 'create',
		beforeContent: undefined,
		afterContent: `content:${path}:${sessionId}`,
		snapshotId: `${sessionId}-snapshot`,
		status: 'pending',
		hunkStatuses: ['pending'],
		hunkSessionIds,
		latestSessionId: sessionId,
		sessionIds,
		diffSignature: `${path}:${sessionId}`,
		updatedAt: sessionIds.length,
	};
}

function createCurrentSession(sessionId: string, status: AgentSessionState['status'] = 'idle'): AgentSessionState {
	return {
		sessionId,
		title: `Session ${sessionId}`,
		status,
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
}

function createAgent(state?: AgentState): AgentRuntimeHandle {
	const stub = createUnavailableAgentRunnerStub();
	stub.loadSession = vi.fn(async (): Promise<AiSession | undefined> => undefined);
	return {
		identified: true,
		state,
		stub,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	};
}

beforeEach(() => {
	useStore.setState({ pendingChanges: new Map() });
	localStorage.clear();
});

describe('useAgentSessions', () => {
	it('preserves the active selection when deleting another session', async () => {
		const state: AgentState = {
			currentSession: createCurrentSession('active-session'),
			sessions: [],
			sessionParticipants: {},
			reviewEntries: {},
			reviewSummary: { unresolvedCount: 0, reviewVersion: 0, sessionCounts: {} },
		};
		const agent = createAgent(state);
		agent.stub.deleteSession = vi.fn(async () => {});
		const { result } = renderHook(() => useAgentSessions({ projectId: 'project-delete', agent, agentConnectionState: 'connected' }));
		setActiveSessionId('project-delete', 'active-session');

		await act(async () => {
			await result.current.handleDeleteSession('other-session');
		});

		expect(getActiveSessionId('project-delete')).toBe('active-session');
	});

	it('ignores a manual session load that completes after a newer selection', async () => {
		const agent = createAgent();
		const first = Promise.withResolvers<AiSession | undefined>();
		const second = Promise.withResolvers<AiSession | undefined>();
		agent.stub.loadSession = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const { result } = renderHook(() => useAgentSessions({ projectId: 'project-load', agent, agentConnectionState: 'connected' }));
		act(() => {
			result.current.handleLoadSession('first');
			result.current.handleLoadSession('second');
		});

		await act(async () => {
			second.resolve({ id: 'second', title: 'Second', createdAt: 2, history: [] });
		});
		await act(async () => {
			first.resolve({ id: 'first', title: 'First', createdAt: 1, history: [] });
		});

		expect(getActiveSessionId('project-load')).toBe('second');
	});

	it('syncs project review queue changes when agent state mutates in place', async () => {
		const state: AgentState = {
			currentSession: createCurrentSession('session-1'),
			sessions: [
				{ id: 'session-1', title: 'Session 1', createdAt: 1, isRunning: false },
				{ id: 'session-2', title: 'Session 2', createdAt: 2, isRunning: false },
			],
			sessionParticipants: {},
			reviewEntries: {
				'/src/a.ts': createReviewEntry('/src/a.ts', 'session-1'),
			},
			reviewSummary: {
				unresolvedCount: 1,
				reviewVersion: 1,
				sessionCounts: { 'session-1': 1 },
			},
		};
		const agent = createAgent(state);

		const { rerender } = renderHook(() => useAgentSessions({ projectId: 'project-1', agent, agentConnectionState: 'connected' }));

		await waitFor(() => {
			expect(useStore.getState().pendingChanges.has('/src/a.ts')).toBe(true);
		});

		state.reviewEntries['/src/b.ts'] = createReviewEntry('/src/b.ts', 'session-2', ['session-2'], [['session-2']]);
		state.reviewSummary.reviewVersion = 2;
		state.reviewSummary.unresolvedCount = 2;
		state.reviewSummary.sessionCounts['session-2'] = 1;

		rerender();

		await waitFor(() => {
			const pendingChange = useStore.getState().pendingChanges.get('/src/b.ts');
			expect(pendingChange?.hunkSessionIds).toEqual([['session-2']]);
		});
	});

	it('preserves project pending changes when the active session is cleared for a new session', async () => {
		const state: AgentState = {
			currentSession: createCurrentSession('session-1'),
			sessions: [{ id: 'session-1', title: 'Session 1', createdAt: 1, isRunning: false }],
			sessionParticipants: {},
			reviewEntries: {
				'/src/a.ts': createReviewEntry('/src/a.ts', 'session-1'),
			},
			reviewSummary: {
				unresolvedCount: 1,
				reviewVersion: 1,
				sessionCounts: { 'session-1': 1 },
			},
		};
		const agent = createAgent(state);

		const { rerender } = renderHook(() => useAgentSessions({ projectId: 'project-1', agent, agentConnectionState: 'connected' }));

		await waitFor(() => {
			expect(useStore.getState().pendingChanges.has('/src/a.ts')).toBe(true);
		});

		state.currentSession = undefined;

		rerender();

		await waitFor(() => {
			const pendingChange = useStore.getState().pendingChanges.get('/src/a.ts');
			expect(pendingChange?.sessionId).toBe('session-1');
		});
	});

	it('syncs live pending changes when a running session mutates them in place', async () => {
		const currentSession = createCurrentSession('session-2', 'running');
		const state: AgentState = {
			currentSession,
			sessions: [{ id: 'session-2', title: 'Session 2', createdAt: 2, isRunning: true }],
			sessionParticipants: {},
			reviewEntries: {},
			reviewSummary: {
				unresolvedCount: 0,
				reviewVersion: 1,
				sessionCounts: {},
			},
		};
		const agent = createAgent(state);

		const { rerender } = renderHook(() => useAgentSessions({ projectId: 'project-1', agent, agentConnectionState: 'connected' }));

		await waitFor(() => {
			expect(useStore.getState().pendingChanges.size).toBe(0);
		});

		currentSession.pendingChanges['/src/live.ts'] = createPendingChange('/src/live.ts', 'session-2');

		rerender();

		await waitFor(() => {
			const liveChange = useStore.getState().pendingChanges.get('/src/live.ts');
			expect(liveChange?.sessionId).toBe('session-2');
		});
	});

	it('does not show a restore spinner when there is no saved session to restore', () => {
		const agent = createAgent();

		const { result } = renderHook(() => useAgentSessions({ projectId: 'project-1', agent, agentConnectionState: 'connecting' }));

		expect(result.current.isRestoringSession).toBe(false);
		expect(agent.stub.loadSession).not.toHaveBeenCalled();
	});

	it('clears stale saved sessions that cannot be restored', async () => {
		localStorage.setItem('worker-ide-project:project-1', JSON.stringify({ activeSessionId: 'missing-session' }));

		const state: AgentState = {
			currentSession: undefined,
			sessions: [],
			sessionParticipants: {},
			reviewEntries: {},
			reviewSummary: {
				unresolvedCount: 0,
				reviewVersion: 1,
				sessionCounts: {},
			},
		};
		const loadSession = vi.fn(async (): Promise<AiSession | undefined> => undefined);
		const agent = createAgent(state);
		agent.stub.loadSession = loadSession;

		const { result } = renderHook(() => useAgentSessions({ projectId: 'project-1', agent, agentConnectionState: 'connected' }));

		await waitFor(() => {
			expect(loadSession).toHaveBeenCalledWith('missing-session');
			expect(result.current.isRestoringSession).toBe(false);
		});

		const stored = JSON.parse(localStorage.getItem('worker-ide-project:project-1') ?? '{}');
		expect(stored.activeSessionId).toBeUndefined();
	});

	it('syncs a restored current session back into persisted session storage', async () => {
		localStorage.setItem('worker-ide-project:project-1', JSON.stringify({ activeSessionId: 'outdated-session' }));

		const state: AgentState = {
			currentSession: createCurrentSession('session-3'),
			sessions: [{ id: 'session-3', title: 'Session 3', createdAt: 3, isRunning: false }],
			sessionParticipants: {},
			reviewEntries: {},
			reviewSummary: {
				unresolvedCount: 0,
				reviewVersion: 1,
				sessionCounts: {},
			},
		};
		const agent = createAgent(state);

		renderHook(() => useAgentSessions({ projectId: 'project-1', agent, agentConnectionState: 'connected' }));

		await waitFor(() => {
			const stored = JSON.parse(localStorage.getItem('worker-ide-project:project-1') ?? '{}');
			expect(stored.activeSessionId).toBe('session-3');
		});

		expect(agent.stub.loadSession).toHaveBeenCalledWith('session-3');
	});
});
