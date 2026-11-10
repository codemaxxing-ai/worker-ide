import { createApiClient } from '@/lib/api-client';
import { throwApiError } from '@/lib/api-error';

import type { AgentMessage } from '@shared/agent-chat';

/** Read the original branch prefix before handing regeneration to the SDK. Hydration may omit this answer or contain summaries. */
export async function regenerateAgentAnswer(
	projectId: string,
	sessionId: string,
	leaf: Pick<AgentMessage, 'id' | 'role'>,
	chat: { setMessages: (messages: AgentMessage[]) => void; regenerate: () => Promise<unknown> },
	signal?: AbortSignal,
): Promise<void> {
	const api = createApiClient(projectId);
	const response = await api.agent.sessions[':sessionId'].history.$get(
		{ param: { sessionId }, query: { leafId: leaf.id, before: leaf.role === 'assistant' ? leaf.id : undefined } },
		{ init: { signal } },
	);
	if (!response.ok) await throwApiError(response, 'Could not read this answer');
	const { messages } = await response.json();
	signal?.throwIfAborted();
	if (messages.length === 0) throw new Error('No saved request to regenerate');
	chat.setMessages(messages);
	await chat.regenerate();
}
