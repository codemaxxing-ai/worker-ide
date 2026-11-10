import { useAgent } from 'agents/react';
import { useCallback, useEffect, useState } from 'react';

import { getActiveSessionId, setActiveSessionId } from '@/lib/project-storage';
import { useStore } from '@/lib/store';

import { AgentRuntimeContext } from './agent-runtime-context';
import { loadAgentDraftSession, saveAgentDraftSession } from '../lib/agent-draft-session';

import type { AgentRuntimeValue, ImageAttachment } from './agent-runtime-context';
import type { AgentState } from '@shared/agent-state';
import type { PendingFileChange } from '@shared/types';
import type { ReactNode } from 'react';

export function AgentRuntimeProvider({ projectId, children }: { projectId: string; children: ReactNode }) {
	const agent = useAgent<AgentState>({
		agent: 'ProjectAgent',
		basePath: `p/${projectId}/__agent`,
		protocol: globalThis.location.protocol === 'https:' ? 'wss' : 'ws',
	});
	const [selectedSessionId, setSelectedSessionId] = useState(
		() => useStore.getState().requestedAgentSessionId ?? getActiveSessionId(projectId),
	);
	const activeSessionId =
		!agent.state?.ready || agent.state.sessions.some((session) => session.id === selectedSessionId) ? selectedSessionId : undefined;
	const draftKey = `${projectId}:${activeSessionId ?? 'new'}`;
	const [draft, setDraft] = useState(() => ({
		key: draftKey,
		segments: loadAgentDraftSession(draftKey)?.segments ?? [],
		cursorPosition: 0,
	}));
	if (draft.key !== draftKey) setDraft({ key: draftKey, segments: loadAgentDraftSession(draftKey)?.segments ?? [], cursorPosition: 0 });
	const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([]);
	const selectSession = useCallback(
		(id?: string) => {
			setSelectedSessionId(id);
			setActiveSessionId(projectId, id);
			setImageAttachments((attachments) => {
				for (const attachment of attachments) URL.revokeObjectURL(attachment.previewUrl);
				return [];
			});
		},
		[projectId],
	);
	useEffect(() => {
		function consumeRequest() {
			const requested = useStore.getState().requestedAgentSessionId;
			if (!requested) return;
			useStore.setState({ requestedAgentSessionId: undefined });
			selectSession(requested);
		}
		consumeRequest();
		return useStore.subscribe(consumeRequest);
	}, [selectSession]);
	useEffect(() => saveAgentDraftSession(draft.key, draft), [draft]);
	useEffect(() => setActiveSessionId(projectId, activeSessionId), [projectId, activeSessionId]);
	const reviewEntries = agent.state?.reviewEntries;
	useEffect(() => {
		if (!reviewEntries) return;
		const changes = new Map<string, PendingFileChange>();
		for (const entry of Object.values(reviewEntries))
			changes.set(entry.path, {
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
		useStore.getState().loadPendingChanges(changes);
	}, [reviewEntries]);
	const setSegments = useCallback<AgentRuntimeValue['setSegments']>(
		(update) => setDraft((previous) => ({ ...previous, segments: typeof update === 'function' ? update(previous.segments) : update })),
		[],
	);
	const setCursorPosition = useCallback<AgentRuntimeValue['setCursorPosition']>(
		(update) =>
			setDraft((previous) => ({ ...previous, cursorPosition: typeof update === 'function' ? update(previous.cursorPosition) : update })),
		[],
	);
	const value: AgentRuntimeValue = {
		agent,
		activeSessionId,
		selectSession,
		agentConnectionState: agent.connectionError ? 'disconnected' : agent.identified ? 'connected' : 'connecting',
		isConnected: agent.identified && !agent.connectionError && agent.state?.ready === true,
		segments: draft.segments,
		setSegments,
		cursorPosition: draft.cursorPosition,
		setCursorPosition,
		imageAttachments,
		setImageAttachments,
	};
	return <AgentRuntimeContext.Provider value={value}>{children}</AgentRuntimeContext.Provider>;
}
