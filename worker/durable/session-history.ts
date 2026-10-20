import { DEFAULT_AI_MODEL, getModelConfig } from '@shared/constants';
import { sanitizePreviewElementReference } from '@shared/preview-element';
import { questionInputSchema } from '@shared/validation/tools';

import type { SessionMessageMetadataInsert, SessionMessageMetadataRow } from './db';
import type { AIModelId } from '@shared/constants';
import type { AgentMode, ChatMessage, UserMessagePart } from '@shared/types';

function isAgentMode(value: unknown): value is AgentMode {
	return value === 'code' || value === 'plan' || value === 'ask';
}

function isRequestState(value: unknown): value is 'queued' | 'committed' {
	return value === 'queued' || value === 'committed';
}

function isAiModelId(value: unknown): value is AIModelId {
	return typeof value === 'string' && !!getModelConfig(value);
}

function isQueuedMessage(message: ChatMessage): boolean {
	return message.role === 'user' && message.metadata?.request?.state === 'queued';
}

function parsePersistedUserMessageParts(partsJson: string | null | undefined): UserMessagePart[] | undefined {
	if (!partsJson) {
		return undefined;
	}

	try {
		const parsed: unknown = JSON.parse(partsJson);
		if (!Array.isArray(parsed)) {
			return undefined;
		}

		const parts: UserMessagePart[] = [];
		for (const part of parsed) {
			if (!part || typeof part !== 'object' || Array.isArray(part) || !('type' in part) || typeof part.type !== 'string') {
				continue;
			}

			if (part.type === 'text' && 'content' in part && typeof part.content === 'string') {
				parts.push({ type: 'text', content: part.content });
				continue;
			}

			if (part.type === 'preview-element') {
				const sanitizedReference = sanitizePreviewElementReference(part);
				if (sanitizedReference) {
					parts.push({ type: 'preview-element', ...sanitizedReference });
				}
				continue;
			}

			if (
				part.type === 'image' &&
				'url' in part &&
				typeof part.url === 'string' &&
				part.url.startsWith('data:') &&
				'mediaType' in part &&
				typeof part.mediaType === 'string'
			) {
				const name = 'name' in part && typeof part.name === 'string' ? part.name : undefined;
				parts.push({ type: 'image', url: part.url, mediaType: part.mediaType, name });
			}
		}

		return parts.length > 0 ? parts : undefined;
	} catch {
		return undefined;
	}
}

export function getQueuedMessages(messages: ChatMessage[]): ChatMessage[] {
	return messages.filter((message) => isQueuedMessage(message));
}

export function getCommittedMessages(messages: ChatMessage[]): ChatMessage[] {
	return messages.filter((message) => !isQueuedMessage(message));
}

/** Restore an unanswered, successfully displayed question from canonical history. */
export function getPendingUserQuestion(messages: ChatMessage[]): { question: string; options: string } | undefined {
	const successfulQuestions = new Set<string>();
	for (const message of messages.toReversed()) {
		if (isQueuedMessage(message)) continue;
		if (message.role === 'user') return;
		for (const part of message.parts.toReversed()) {
			if (part.type === 'tool-result' && part.toolName === 'user_question' && !part.isError) {
				successfulQuestions.add(part.toolCallId);
			}
			if (part.type !== 'tool-call' || part.toolName !== 'user_question' || !successfulQuestions.has(part.toolCallId)) continue;
			const question = questionInputSchema.safeParse(part.arguments);
			if (question.success) return { question: question.data.question, options: question.data.options ?? '' };
		}
	}
}

export function getLastCommittedRequestConfig(messages: ChatMessage[]): { mode: AgentMode; model: AIModelId } {
	for (let index = messages.length - 1; index >= 0; index--) {
		const request = messages[index]?.metadata?.request;
		if (messages[index]?.role === 'user' && request?.state === 'committed') {
			return {
				mode: request.mode ?? 'code',
				model: request.model ?? DEFAULT_AI_MODEL,
			};
		}
	}

	return { mode: 'code', model: DEFAULT_AI_MODEL };
}

export function promoteNextQueuedMessage(messages: ChatMessage[]): { history: ChatMessage[]; promotedMessage: ChatMessage | undefined } {
	const queuedIndex = messages.findIndex((message) => isQueuedMessage(message));
	if (queuedIndex === -1) {
		return { history: messages, promotedMessage: undefined };
	}

	const queuedMessage = messages[queuedIndex];
	const promotedMessage: ChatMessage = {
		...queuedMessage,
		metadata: {
			...queuedMessage.metadata,
			request: {
				...queuedMessage.metadata?.request,
				state: 'committed',
			},
		},
	};

	const history = [...messages];
	history[queuedIndex] = promotedMessage;
	return { history, promotedMessage };
}

export function mergeQueuedMessages(committedHistory: ChatMessage[], existingHistory: ChatMessage[]): ChatMessage[] {
	const existingQueuedMessages = existingHistory.filter(
		(message) => isQueuedMessage(message) && !committedHistory.some((candidate) => candidate.id === message.id),
	);
	if (existingQueuedMessages.length === 0) {
		return committedHistory;
	}
	return [...committedHistory, ...existingQueuedMessages];
}

export function applyPersistedMessageMetadata(history: ChatMessage[], rows: SessionMessageMetadataRow[]): ChatMessage[] {
	if (rows.length === 0) {
		return history;
	}

	const metadataByMessageId = new Map(rows.map((row) => [row.messageId, row]));
	return history.map((message) => {
		const row = metadataByMessageId.get(message.id);
		if (!row) {
			return message;
		}

		const requestState = isRequestState(row.requestState) ? row.requestState : message.metadata?.request?.state;
		const requestMode = isAgentMode(row.requestMode) ? row.requestMode : message.metadata?.request?.mode;
		const requestModel = isAiModelId(row.requestModel) ? row.requestModel : message.metadata?.request?.model;
		const persistedParts = message.role === 'user' ? parsePersistedUserMessageParts(row.partsJson) : undefined;
		const request =
			message.role === 'user' && (requestState || requestMode || requestModel)
				? {
						state: requestState ?? 'committed',
						mode: requestMode,
						model: requestModel,
					}
				: message.metadata?.request;

		return {
			...message,
			authorUserId: row.authorUserId ?? message.authorUserId,
			parts: persistedParts ?? message.parts,
			metadata: {
				...message.metadata,
				request,
				snapshotId: row.snapshotId ?? message.metadata?.snapshotId,
			},
		};
	});
}

export function serializePersistedMessageMetadata(sessionId: string, history: ChatMessage[]): SessionMessageMetadataInsert[] {
	const rows: SessionMessageMetadataInsert[] = [];
	for (const message of history) {
		const request = message.role === 'user' ? message.metadata?.request : undefined;
		const partsJson =
			message.role === 'user' && message.parts.some((part) => part.type === 'preview-element' || part.type === 'image')
				? JSON.stringify(message.parts)
				: undefined;
		const snapshotId = message.metadata?.snapshotId;
		if (!request && !snapshotId && !partsJson && !message.authorUserId) {
			continue;
		}

		rows.push({
			sessionId,
			messageId: message.id,
			requestMode: request?.mode,
			requestModel: request?.model,
			requestState: request?.state,
			authorUserId: message.authorUserId,
			partsJson,
			snapshotId,
		});
	}

	return rows;
}

export function setSnapshotOnLastCommittedUserMessage(messages: ChatMessage[], snapshotId: string): ChatMessage[] {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== 'user' || message.metadata?.request?.state === 'queued') {
			continue;
		}

		const updated = [...messages];
		updated[index] = {
			...message,
			metadata: {
				...message.metadata,
				snapshotId,
			},
		};
		return updated;
	}

	return messages;
}

export function clearSnapshotFromMessages(messages: ChatMessage[], snapshotId: string): ChatMessage[] {
	let changed = false;
	const updated = messages.map((message) => {
		if (message.metadata?.snapshotId !== snapshotId) {
			return message;
		}

		changed = true;
		return {
			...message,
			metadata: {
				...message.metadata,
				snapshotId: undefined,
			},
		};
	});

	return changed ? updated : messages;
}
