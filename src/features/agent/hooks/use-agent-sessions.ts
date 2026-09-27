import { useCallback, useEffect, useRef, useState } from 'react';

import { toast } from '@/components/ui/toast-store';
import { isAgentState } from '@/features/agent/lib/agent-state';
import { getActiveSessionId, setActiveSessionId } from '@/lib/project-storage';
import { useStore } from '@/lib/store';

import type { AgentConnectionState, AgentRuntimeHandle } from '../components/agent-runtime-context';
import type { AgentState } from '@shared/agent-state';
import type { PendingFileChange, AiSession } from '@shared/types';

type SessionLoadPhase = 'idle' | 'awaiting-agent-state' | 'loading-saved-session';
type SessionLoadResult = { status: 'loaded'; session: AiSession } | { status: 'missing' } | { status: 'error' } | { status: 'superseded' };

export function useAgentSessions({
	projectId,
	agent,
	agentConnectionState,
}: {
	projectId: string;
	agent: AgentRuntimeHandle;
	agentConnectionState: AgentConnectionState;
}) {
	// Session list comes from agent.state.sessions (auto-synced)
	const rawState = agent.state;
	const agentState: AgentState | undefined = isAgentState(rawState) ? rawState : undefined;
	const savedSessions = agentState?.sessions ?? [];
	const [sessionSearchQuery, setSessionSearchQuery] = useState('');
	const [searchedSessionIds, setSearchedSessionIds] = useState<string[] | undefined>();
	const displaySessions = sessionSearchQuery.trim()
		? savedSessions.filter((session) => searchedSessionIds?.includes(session.id))
		: savedSessions;

	useEffect(() => {
		if (!sessionSearchQuery.trim()) {
			return;
		}

		let cancelled = false;
		void agent.stub
			.searchSessions(sessionSearchQuery.trim(), 20)
			.then((results) => {
				if (cancelled) return;
				setSearchedSessionIds([...new Set(results.map((result) => result.sessionId))]);
			})
			.catch(() => {
				if (cancelled) return;
				setSearchedSessionIds([]);
			});

		return () => {
			cancelled = true;
		};
	}, [agent, sessionSearchQuery]);

	// =========================================================================
	// Load a session via Agent RPC
	// =========================================================================

	const [isLoadingSession, setIsLoadingSession] = useState(false);
	const [sessionSnapshot, setSessionSnapshot] = useState<AiSession | undefined>();
	const [snapshotHistoryVersion, setSnapshotHistoryVersion] = useState(-1);
	const sessionLoadSequenceReference = useRef(0);
	useEffect(
		() => () => {
			sessionLoadSequenceReference.current += 1;
		},
		[projectId],
	);
	const [sessionLoadPhase, setSessionLoadPhase] = useState<SessionLoadPhase>(() => {
		const currentSession = agentState?.currentSession;
		return !currentSession && getActiveSessionId(projectId) ? 'awaiting-agent-state' : 'idle';
	});

	const updateSessionLoadPhase = useCallback((nextPhase: SessionLoadPhase) => {
		queueMicrotask(() => {
			setSessionLoadPhase((currentPhase) => (currentPhase === nextPhase ? currentPhase : nextPhase));
		});
	}, []);

	const loadSessionById = useCallback(
		async (targetSessionId: string, reason: 'manual' | 'restore'): Promise<SessionLoadResult> => {
			const sequence = ++sessionLoadSequenceReference.current;
			const isCurrent = () => sequence === sessionLoadSequenceReference.current;
			if (reason === 'manual') {
				setIsLoadingSession(true);
			} else {
				updateSessionLoadPhase('loading-saved-session');
			}

			try {
				const session = await agent.stub.loadSession(targetSessionId);
				if (!isCurrent()) return { status: 'superseded' };
				if (!session) {
					if (getActiveSessionId(projectId) === targetSessionId) {
						setActiveSessionId(projectId, undefined);
					}
					if (reason === 'manual') {
						toast.error('This session is no longer available.');
					}
					return { status: 'missing' };
				}

				setActiveSessionId(projectId, session.id);
				setSessionSnapshot(session);
				setSnapshotHistoryVersion(agent.state?.currentSession?.historyVersion ?? 0);
				return { status: 'loaded', session };
			} catch {
				if (!isCurrent()) return { status: 'superseded' };
				if (reason === 'manual') {
					toast.error('Could not load the session. Please try again.');
				}
				return { status: 'error' };
			} finally {
				if (isCurrent() && reason === 'manual') {
					setIsLoadingSession(false);
				} else if (isCurrent()) {
					updateSessionLoadPhase('idle');
				}
			}
		},
		[agent, projectId, updateSessionLoadPhase],
	);

	const handleLoadSession = useCallback(
		(targetSessionId: string) => {
			void loadSessionById(targetSessionId, 'manual');
		},
		[loadSessionById],
	);

	// =========================================================================
	// Rename a session via Agent RPC
	// =========================================================================

	const handleRenameSession = useCallback(
		async (targetSessionId: string, newTitle: string): Promise<boolean> => {
			try {
				await agent.stub.renameSession(targetSessionId, newTitle);
				return true;
			} catch {
				toast.error('Could not rename the session. Please try again.');
				return false;
			}
		},
		[agent],
	);

	// =========================================================================
	// Delete a session via Agent RPC
	// =========================================================================

	const handleDeleteSession = useCallback(
		async (targetSessionId: string): Promise<boolean> => {
			try {
				await agent.stub.deleteSession(targetSessionId);
				if (getActiveSessionId(projectId) === targetSessionId) {
					setActiveSessionId(projectId, undefined);
				}
				return true;
			} catch {
				toast.error('Could not delete the session. Please try again.');
				return false;
			}
		},
		[agent, projectId],
	);

	// =========================================================================
	// Auto-restore the active session on mount
	// =========================================================================

	const attemptedRestoreSessionIdReference = useRef<string | undefined>(undefined);

	// Track the last-known session ID so we can distinguish "session genuinely
	// cleared" from "transient undefined during loadSession switch".
	const lastSessionIdReference = useRef(agentState?.currentSession?.sessionId);

	// Sync the authoritative project review queue into the Zustand store.
	// While a session is actively running, overlay its live pending changes so
	// the editor can preview in-flight edits before the turn is persisted.
	const agentSessionId = agentState?.currentSession?.sessionId;
	const agentPendingChanges = agentState?.currentSession?.pendingChanges;
	const authoritativeReviewEntries = agentState?.reviewEntries;
	const isSessionRunning = agentState?.currentSession?.status === 'running';
	const authoritativeReviewSignature = JSON.stringify(authoritativeReviewEntries ?? {});
	const agentPendingChangesSignature = JSON.stringify(agentPendingChanges ?? {});
	const authoritativeReviewEntriesReference = useRef(authoritativeReviewEntries);
	const agentPendingChangesReference = useRef(agentPendingChanges);
	useEffect(() => {
		authoritativeReviewEntriesReference.current = authoritativeReviewEntries;
		agentPendingChangesReference.current = agentPendingChanges;
	}, [authoritativeReviewEntries, agentPendingChanges]);

	useEffect(() => {
		const current = useStore.getState().pendingChanges;
		const merged = new Map<string, PendingFileChange>();

		for (const entry of Object.values(authoritativeReviewEntriesReference.current ?? {})) {
			merged.set(entry.path, {
				path: entry.path,
				action: entry.action,
				beforeContent: entry.beforeContent,
				afterContent: entry.afterContent,
				snapshotId: entry.snapshotId,
				status: 'pending',
				hunkStatuses: entry.hunkStatuses,
				hunkSessionIds: entry.hunkSessionIds,
				sessionId: entry.latestSessionId,
				sessionIds: entry.sessionIds,
				reviewId: entry.id,
			});
		}

		if (isSessionRunning && agentPendingChangesReference.current) {
			for (const [path, change] of Object.entries(agentPendingChangesReference.current)) {
				const existing = merged.get(path);
				merged.set(path, {
					...change,
					sessionId: existing?.sessionId ?? change.sessionId,
					sessionIds: existing?.sessionIds ?? change.sessionIds,
					reviewId: existing?.reviewId,
					hunkStatuses: existing?.hunkStatuses ?? change.hunkStatuses,
					hunkSessionIds: existing?.hunkSessionIds ?? change.hunkSessionIds,
				});
			}
		}

		if (merged.size === 0 && agentSessionId === undefined && lastSessionIdReference.current !== undefined) {
			lastSessionIdReference.current = undefined;
			if (current.size > 0) {
				useStore.getState().loadPendingChanges(new Map());
			}
			return;
		}

		lastSessionIdReference.current = agentSessionId;
		useStore.getState().loadPendingChanges(merged);
	}, [agentSessionId, agentPendingChangesSignature, authoritativeReviewSignature, isSessionRunning]);

	useEffect(() => {
		const currentSession = agentState?.currentSession;
		const activeSessionId = getActiveSessionId(projectId);

		if (currentSession) {
			attemptedRestoreSessionIdReference.current = currentSession.sessionId;
			if (activeSessionId !== currentSession.sessionId) {
				setActiveSessionId(projectId, currentSession.sessionId);
			}
			updateSessionLoadPhase('idle');
			return;
		}

		if (!activeSessionId) {
			attemptedRestoreSessionIdReference.current = undefined;
			updateSessionLoadPhase('idle');
			return;
		}

		if (!agentState) {
			updateSessionLoadPhase(agentConnectionState === 'disconnected' ? 'idle' : 'awaiting-agent-state');
			return;
		}

		if (attemptedRestoreSessionIdReference.current === activeSessionId) {
			updateSessionLoadPhase('idle');
			return;
		}

		attemptedRestoreSessionIdReference.current = activeSessionId;
		void loadSessionById(activeSessionId, 'restore').then((result) => {
			if (result.status === 'missing' || result.status === 'error') {
				attemptedRestoreSessionIdReference.current = undefined;
			}
		});
	}, [agentConnectionState, agentState, loadSessionById, projectId, updateSessionLoadPhase]);

	useEffect(() => {
		const currentSession = agentState?.currentSession;
		if (!currentSession) {
			queueMicrotask(() => {
				setSessionSnapshot(undefined);
				setSnapshotHistoryVersion(-1);
			});
			return;
		}

		if (sessionSnapshot?.id === currentSession.sessionId && snapshotHistoryVersion === currentSession.historyVersion) {
			return;
		}

		let cancelled = false;
		void agent.stub
			.loadSession(currentSession.sessionId)
			.then((session) => {
				if (cancelled || !session) return;
				setSessionSnapshot(session);
				setSnapshotHistoryVersion(currentSession.historyVersion);
			})
			.catch((error: unknown) => {
				// Keep the last snapshot during a transient disconnect. A later
				// state update retries the refresh without an unhandled rejection.
				if (!cancelled) console.warn('[AgentSessions] Failed to refresh session history:', error);
			});

		return () => {
			cancelled = true;
		};
	}, [agent.stub, agentState?.currentSession, sessionSnapshot?.id, snapshotHistoryVersion]);

	const isRestoringSession =
		sessionLoadPhase === 'loading-saved-session' || (sessionLoadPhase === 'awaiting-agent-state' && agentConnectionState === 'connecting');

	return {
		allSessions: savedSessions,
		savedSessions: displaySessions,
		handleLoadSession,
		handleRenameSession,
		handleDeleteSession,
		sessionSearchQuery,
		setSessionSearchQuery,
		isRestoringSession: isRestoringSession || isLoadingSession,
		sessionSnapshot,
	};
}
