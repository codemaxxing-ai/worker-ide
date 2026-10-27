import { readSessionMessageMetadata, readSessionMetadata, replaceSessionMessageMetadata, upsertSessionMetadata } from './db';
import { applyPersistedMessageMetadata, serializePersistedMessageMetadata } from './session-history';
import { compactHistoryForPersistence } from '../services/agent/persisted-history-compactor';
import { chatMessageToSessionMessage, sessionMessagesToChatMessages } from '../services/agent/session-messages';

import type { AgentDatabase, SessionMetadataRow } from './db';
import type { StreamEvent } from '@shared/agent-state';
import type { AgentSessionStatus, AiSession, ChatMessage, ToolErrorInfo, ToolMetadataInfo } from '@shared/types';
import type { SessionInfo, SessionMessage } from 'agents/experimental/memory/session';

const AGENT_SESSION_STATUSES: ReadonlySet<string> = new Set(['running', 'completed', 'error', 'aborted']);

function isAgentSessionStatus(value: unknown): value is AgentSessionStatus {
	return typeof value === 'string' && AGENT_SESSION_STATUSES.has(value);
}

interface SessionMetadataState {
	titleGenerated?: boolean;
	contextTokensUsed?: number;
	toolMetadata?: Record<string, ToolMetadataInfo>;
	toolErrors?: Record<string, ToolErrorInfo>;
	debugLogId?: string;
	status?: AgentSessionStatus;
	errorMessage?: string;
	stopRequested?: boolean;
}

interface SessionHistoryStore {
	get(sessionId: string): SessionInfo | null | undefined;
	getHistory(sessionId: string): SessionMessage[] | Promise<SessionMessage[]>;
	clearMessages(sessionId: string): unknown;
	appendAll(sessionId: string, messages: SessionMessage[], parentId?: string): unknown;
}

function parseSessionMetadata(row: SessionMetadataRow | undefined): SessionMetadataState {
	if (!row) {
		return {};
	}

	return {
		titleGenerated: row.titleGenerated === 1,
		contextTokensUsed: row.contextTokensUsed ?? undefined,
		toolMetadata: row.toolMetadata ? JSON.parse(row.toolMetadata) : undefined,
		toolErrors: row.toolErrors ? JSON.parse(row.toolErrors) : undefined,
		debugLogId: row.debugLogId ?? undefined,
		status: isAgentSessionStatus(row.status) ? row.status : undefined,
		errorMessage: row.errorMessage ?? undefined,
		stopRequested: row.stopRequested === 1,
	};
}

function buildAiSession(sessionInfo: SessionInfo, history: ChatMessage[], metadata: SessionMetadataState): AiSession {
	return {
		id: sessionInfo.id,
		title: sessionInfo.name,
		titleGenerated: metadata.titleGenerated,
		createdAt: Date.parse(sessionInfo.created_at),
		history,
		contextTokensUsed: metadata.contextTokensUsed,
		toolMetadata: metadata.toolMetadata,
		toolErrors: metadata.toolErrors,
		status: metadata.status,
		errorMessage: metadata.errorMessage,
		stopRequested: metadata.stopRequested,
	};
}

function getSharedPrefixLength(left: ChatMessage[], right: ChatMessage[]): number {
	const shortestLength = Math.min(left.length, right.length);
	let index = 0;
	while (index < shortestLength && left[index]?.id === right[index]?.id) {
		index++;
	}
	return index;
}

export class AgentSessionStore {
	constructor(
		private database: AgentDatabase,
		private sessionHistoryStore: SessionHistoryStore,
	) {}

	getMetadata(sessionId: string): SessionMetadataState {
		return parseSessionMetadata(readSessionMetadata(this.database, sessionId));
	}

	recordToolEvents(sessionId: string, events: StreamEvent[]): void {
		const results = events.filter((event) => event.type === 'tool-result' || event.type === 'tool-error');
		if (results.length === 0) return;
		const existing = this.getMetadata(sessionId);
		const toolMetadata = { ...existing.toolMetadata };
		const toolErrors = { ...existing.toolErrors };
		for (const event of results) {
			if (!event.toolCallId) continue;
			if (event.type === 'tool-result') {
				toolMetadata[event.toolCallId] = {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					title: event.title,
					metadata: event.metadata,
				};
				continue;
			}
			toolErrors[event.toolCallId] = {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				errorCode: event.errorCode,
				errorMessage: event.errorMessage,
			};
		}
		this.writeMetadata(sessionId, { toolMetadata, toolErrors });
	}

	async read(sessionId: string): Promise<AiSession | undefined> {
		const sessionInfo = this.sessionHistoryStore.get(sessionId);
		if (!sessionInfo) {
			return undefined;
		}

		const metadata = this.getMetadata(sessionId);
		const sessionHistory = sessionMessagesToChatMessages(await this.sessionHistoryStore.getHistory(sessionId));
		const persistedMessageMetadata = readSessionMessageMetadata(this.database, sessionId);
		const history = applyPersistedMessageMetadata(sessionHistory, persistedMessageMetadata);
		return buildAiSession(sessionInfo, history, metadata);
	}

	async getHistory(sessionId: string): Promise<ChatMessage[]> {
		const session = await this.read(sessionId);
		return session?.history ?? [];
	}

	writeMetadata(sessionId: string, patch: Partial<SessionMetadataState>): void {
		const existing = this.getMetadata(sessionId);
		const toolMetadata = patch.toolMetadata ?? existing.toolMetadata;
		const toolErrors = patch.toolErrors ?? existing.toolErrors;

		upsertSessionMetadata(this.database, {
			id: sessionId,
			titleGenerated: (patch.titleGenerated ?? existing.titleGenerated) ? 1 : 0,
			contextTokensUsed: patch.contextTokensUsed ?? existing.contextTokensUsed,
			toolMetadata: toolMetadata ? JSON.stringify(toolMetadata) : undefined,
			toolErrors: toolErrors ? JSON.stringify(toolErrors) : undefined,
			debugLogId: patch.debugLogId ?? existing.debugLogId,
			status: patch.status ?? existing.status,
			errorMessage: Object.hasOwn(patch, 'errorMessage') ? patch.errorMessage : existing.errorMessage,
			stopRequested: (patch.stopRequested ?? existing.stopRequested) ? 1 : 0,
		});
	}

	async replaceHistory(sessionId: string, history: ChatMessage[]): Promise<void> {
		const compactedHistory = compactHistoryForPersistence(history);
		await this.sessionHistoryStore.clearMessages(sessionId);
		await this.sessionHistoryStore.appendAll(
			sessionId,
			compactedHistory.map((message) => chatMessageToSessionMessage(message)),
		);
		replaceSessionMessageMetadata(this.database, sessionId, serializePersistedMessageMetadata(sessionId, compactedHistory));
	}

	async syncHistory(sessionId: string, history: ChatMessage[]): Promise<void> {
		const compactedHistory = compactHistoryForPersistence(history);
		const existingHistory = sessionMessagesToChatMessages(await this.sessionHistoryStore.getHistory(sessionId));
		const sharedPrefixLength = getSharedPrefixLength(existingHistory, compactedHistory);

		if (sharedPrefixLength !== existingHistory.length) {
			await this.replaceHistory(sessionId, compactedHistory);
			return;
		}

		const suffix = compactedHistory.slice(sharedPrefixLength);
		if (suffix.length > 0) {
			const parentId = sharedPrefixLength > 0 ? compactedHistory[sharedPrefixLength - 1]?.id : undefined;
			await this.sessionHistoryStore.appendAll(
				sessionId,
				suffix.map((message) => chatMessageToSessionMessage(message)),
				parentId,
			);
		}

		replaceSessionMessageMetadata(this.database, sessionId, serializePersistedMessageMetadata(sessionId, compactedHistory));
	}

	async persistHistory(sessionId: string, history: ChatMessage[], stopRequested?: boolean): Promise<void> {
		await this.syncHistory(sessionId, history);
		this.writeMetadata(sessionId, { stopRequested });
	}
}
