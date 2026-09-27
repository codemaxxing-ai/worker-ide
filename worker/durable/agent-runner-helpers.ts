import { ExtensionManager } from '@cloudflare/think/extensions';

import type { PushUrgency } from '@shared/notification-types';
import type { AgentSessionStatus, ChatMessage } from '@shared/types';

interface RestorableExtensionManager {
	restore(): Promise<void>;
	list(): Array<{ name: string; description?: string; tools: unknown[] }>;
}

interface ExtensionManagerConstructor<T extends RestorableExtensionManager> {
	new (options: { loader: WorkerLoader; storage: DurableObjectStorage }): T;
}

interface TerminalNotification {
	title: string;
	body: string;
	urgency?: PushUrgency;
}

export interface ActiveThinkSubmission {
	submissionId: string;
	status: 'pending' | 'running';
}

export function mergeThinkHistory(history: ChatMessage[], existingHistory: ChatMessage[]): ChatMessage[] {
	const existingMessages = new Map(existingHistory.map((message) => [message.id, message]));
	return history.map((message) => {
		const existing = existingMessages.get(message.id);
		if (!existing) return message;
		return {
			...message,
			parts: message.role === 'user' ? existing.parts : message.parts,
			createdAt: existing.createdAt,
			authorUserId: existing.authorUserId,
			metadata:
				message.role === 'user' && existing.metadata?.request
					? { ...existing.metadata, request: { ...existing.metadata.request, state: 'committed' } }
					: existing.metadata,
		};
	});
}

export function getActiveThinkMessages(messages: ChatMessage[], submissions: ActiveThinkSubmission[]): ChatMessage[] {
	const statuses = new Map(submissions.map((submission) => [submission.submissionId, submission.status]));
	return messages
		.filter((message) => statuses.has(message.id))
		.map((message) => {
			if (message.role !== 'user' || !message.metadata?.request) return message;
			return {
				...message,
				metadata: {
					...message.metadata,
					request: { ...message.metadata.request, state: statuses.get(message.id) === 'running' ? 'committed' : 'queued' },
				},
			};
		});
}

/**
 * Reattach `authorUserId` and `metadata` from a source history onto a forked
 * history by position.
 *
 * `SessionManager.fork` assigns fresh message IDs to every copied message and
 * does not copy the agent-side per-message metadata (author, request mode/model,
 * snapshot id). The forked history is a positional prefix of the source history,
 * so the original state is reattached by index rather than by message ID — an
 * ID-based match would never hit, leaving authors resolved as "Unknown".
 */
export function reattachForkedMessageState(forkedHistory: readonly ChatMessage[], sourceHistory: readonly ChatMessage[]): ChatMessage[] {
	return forkedHistory.map((message, index) => ({
		...message,
		authorUserId: sourceHistory[index]?.authorUserId,
		metadata: sourceHistory[index]?.metadata,
	}));
}

export async function restoreExtensionManager(loader: WorkerLoader, storage: DurableObjectStorage): Promise<ExtensionManager>;
export async function restoreExtensionManager<T extends RestorableExtensionManager>(
	loader: WorkerLoader,
	storage: DurableObjectStorage,
	ManagerClass: ExtensionManagerConstructor<T>,
): Promise<T>;
export async function restoreExtensionManager<T extends RestorableExtensionManager>(
	loader: WorkerLoader,
	storage: DurableObjectStorage,
	ManagerClass?: ExtensionManagerConstructor<T>,
) {
	const ResolvedManagerClass = ManagerClass ?? ExtensionManager;
	const extensionManager = new ResolvedManagerClass({ loader, storage });
	await extensionManager.restore();
	return extensionManager;
}

export function buildLoadedExtensionsSummary(
	extensionManager?: Pick<RestorableExtensionManager, 'list'>,
): Array<{ name: string; description?: string; toolCount: number }> {
	if (!extensionManager) {
		return [];
	}

	return extensionManager.list().map((extension) => ({
		name: extension.name,
		description: extension.description,
		toolCount: extension.tools.length,
	}));
}

export function buildTerminalNotification(
	status: AgentSessionStatus,
	errorMessage: string | undefined,
	hasQueuedFollowUp: boolean,
): TerminalNotification | undefined {
	if (hasQueuedFollowUp) {
		return undefined;
	}

	if (status === 'completed') {
		return {
			title: 'Generation complete',
			body: 'Your AI agent has finished.',
			urgency: 'normal',
		};
	}

	if (status === 'error') {
		return {
			title: 'Generation failed',
			body: errorMessage ?? 'An error occurred.',
			urgency: 'high',
		};
	}

	return undefined;
}

export async function runSessionSearch<Result>(
	query: string,
	limit: number,
	search: (trimmedQuery: string, resolvedLimit: number) => Promise<Result[]> | Result[],
): Promise<Result[]> {
	const trimmedQuery = query.trim();
	if (!trimmedQuery) {
		return [];
	}

	return search(trimmedQuery, limit);
}
