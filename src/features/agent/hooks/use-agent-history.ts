import { useInfiniteQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { createApiClient } from '@/lib/api-client';
import { throwApiError } from '@/lib/api-error';

import type { AgentMessage } from '@shared/agent-chat';

/** Original transcript pages own order and branch membership. Only the live assistant comes from the SDK's inference view. */
export function useAgentHistory(projectId: string, sessionId: string, latestMessage: AgentMessage | undefined, streaming: boolean) {
	const api = useMemo(() => createApiClient(projectId), [projectId]);
	const history = useInfiniteQuery({
		// A changed SDK tail means a new message or branch, never an extension of previously paged history.
		queryKey: ['agent-history', projectId, sessionId, latestMessage?.id],
		gcTime: 0,
		initialPageParam: firstPage(),
		queryFn: async ({ pageParam, signal }) => {
			const response = await api.agent.sessions[':sessionId'].history.$get(
				{ param: { sessionId }, query: pageParam },
				{ init: { signal } },
			);
			if (!response.ok) await throwApiError(response, 'Could not read history');
			return response.json();
		},
		getNextPageParam: (page) => (page.before ? { before: page.before } : undefined),
	});
	const original = useMemo(() => history.data?.pages.toReversed().flatMap((page) => page.messages) ?? [], [history.data]);
	const messages = useMemo(() => {
		if (!streaming || latestMessage?.role !== 'assistant' || !latestMessage.metadata?.submissionId) return original;
		const last = original.at(-1);
		if (last?.id === latestMessage.id) return [...original.slice(0, -1), latestMessage];
		return last?.role === 'user' ? [...original, latestMessage] : original;
	}, [original, latestMessage, streaming]);
	return {
		messages,
		error: history.error,
		hasEarlier: history.hasNextPage,
		loadingEarlier: history.isFetchingNextPage,
		loadEarlier: history.fetchNextPage,
	};
}

function firstPage(): { before?: string } {
	return {};
}
