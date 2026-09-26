import { useMemo } from 'react';

import type { AgentSessionState } from '@shared/agent-state';
import type { AIModelId } from '@shared/constants';
import type { AgentMode, AiSession, ChatMessage } from '@shared/types';

type OptimisticMessageEntry = {
	sessionId: string;
	message: ChatMessage;
	clientOnly: boolean;
	submitting: boolean;
};

interface AgentMessageTimelineOptions {
	sessionId: string | undefined;
	currentSession: Pick<AgentSessionState, 'sessionId' | 'messages'> | undefined;
	sessionSnapshot: Pick<AiSession, 'id' | 'history'> | undefined;
	optimisticMessages: OptimisticMessageEntry[];
	optimisticRemovedQueuedMessages: Array<{ sessionId: string; messageId: string }>;
}

function isQueuedRequestMessage(message: ChatMessage): boolean {
	return message.role === 'user' && message.metadata?.request?.state === 'queued';
}

function createOptimisticUserMessage(
	parts: ChatMessage['parts'],
	mode: AgentMode,
	model: AIModelId,
	state: 'queued' | 'committed',
	authorUserId: string | undefined,
	id: string,
	createdAt: number,
): ChatMessage {
	return {
		id,
		role: 'user',
		parts,
		authorUserId,
		createdAt,
		metadata: { request: { mode, model, state } },
	};
}

function useAgentMessageTimeline({
	sessionId,
	currentSession,
	sessionSnapshot,
	optimisticMessages,
	optimisticRemovedQueuedMessages,
}: AgentMessageTimelineOptions) {
	const renderedSessionId = sessionId ?? optimisticMessages.at(-1)?.sessionId;
	const renderedOptimisticEntries = useMemo(
		() => (renderedSessionId ? optimisticMessages.filter((entry) => entry.sessionId === renderedSessionId) : []),
		[optimisticMessages, renderedSessionId],
	);
	const renderedOptimisticMessages = useMemo(() => renderedOptimisticEntries.map((entry) => entry.message), [renderedOptimisticEntries]);
	const localOnlyMessageIds = useMemo(
		() => new Set(renderedOptimisticEntries.filter((entry) => entry.clientOnly).map((entry) => entry.message.id)),
		[renderedOptimisticEntries],
	);
	const removedQueuedMessageIds = useMemo(
		() => new Set(optimisticRemovedQueuedMessages.filter((entry) => entry.sessionId === renderedSessionId).map((entry) => entry.messageId)),
		[optimisticRemovedQueuedMessages, renderedSessionId],
	);
	const serverMessages = useMemo(() => {
		const durableMessages = sessionSnapshot && sessionSnapshot.id === renderedSessionId ? sessionSnapshot.history : [];
		const liveMessages = currentSession && currentSession.sessionId === renderedSessionId ? currentSession.messages : [];
		const liveById = new Map(liveMessages.map((message) => [message.id, message]));
		return [
			...durableMessages.map((message) => liveById.get(message.id) ?? message),
			...liveMessages.filter((message) => !durableMessages.some((durableMessage) => durableMessage.id === message.id)),
		];
	}, [currentSession, renderedSessionId, sessionSnapshot]);
	const allMessages = useMemo(() => {
		const mergedMessages =
			renderedOptimisticMessages.length === 0
				? serverMessages
				: [
						...serverMessages,
						...renderedOptimisticMessages.filter((message) => !new Set(serverMessages.map((entry) => entry.id)).has(message.id)),
					];
		if (removedQueuedMessageIds.size === 0) {
			return mergedMessages;
		}
		return mergedMessages.filter((message) => !removedQueuedMessageIds.has(message.id));
	}, [renderedOptimisticMessages, removedQueuedMessageIds, serverMessages]);
	const queuedMessages = useMemo(() => allMessages.filter((message) => isQueuedRequestMessage(message)), [allMessages]);
	const committedMessages = useMemo(() => allMessages.filter((message) => !isQueuedRequestMessage(message)), [allMessages]);

	return {
		renderedSessionId,
		renderedOptimisticEntries,
		renderedOptimisticMessages,
		localOnlyMessageIds,
		serverMessages,
		allMessages,
		queuedMessages,
		committedMessages,
	};
}

export { createOptimisticUserMessage, useAgentMessageTimeline, type OptimisticMessageEntry };
