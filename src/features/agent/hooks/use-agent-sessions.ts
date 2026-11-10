import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { createApiClient } from '@/lib/api-client';
import { throwApiError } from '@/lib/api-error';

import { useAgentRuntime } from '../components/agent-runtime-context';

export function useAgentSessions(projectId: string) {
	const { agent, activeSessionId, selectSession } = useAgentRuntime();
	const [query, setQuery] = useState('');
	const api = useMemo(() => createApiClient(projectId), [projectId]);
	const search = useQuery({
		queryKey: ['agent-session-search', projectId, query],
		enabled: query.trim().length > 0,
		queryFn: async ({ signal }) => {
			const response = await api.agent.sessions.search.$get({ query: { query: query.trim() } }, { init: { signal } });
			if (!response.ok) await throwApiError(response, 'Session search failed');
			return response.json();
		},
	});
	const allSessions = agent.state?.sessions ?? [];
	const sessions = query.trim()
		? allSessions.filter(
				(session) =>
					session.title.toLowerCase().includes(query.toLowerCase()) || search.data?.matches.some((match) => match.sessionId === session.id),
			)
		: allSessions;
	async function renameSession(id: string, title: string) {
		const response = await api.agent.sessions[':sessionId'].title.$put({ param: { sessionId: id }, json: { title } });
		if (!response.ok) await throwApiError(response, 'Could not rename the session');
	}
	async function deleteSession(id: string) {
		const response = await api.agent.sessions[':sessionId'].$delete({ param: { sessionId: id } });
		if (!response.ok) await throwApiError(response, 'Could not delete the session');
		if (activeSessionId === id) selectSession();
	}
	return { sessions, allSessions, query, setQuery, isSearching: search.isFetching, renameSession, deleteSession };
}
