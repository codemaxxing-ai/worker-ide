import type { AgentState } from './agent-state';
import type { AIModelId } from './constants';
import type { AgentMode, AiSession, ChatMessage, PendingFileChange, ReviewEntry } from './types';

export interface SubmitMessageRequest {
	parts: unknown;
	sessionId?: string;
	mode?: AgentMode;
	model?: AIModelId;
	messageId: string;
	createdAt: number;
}

export interface StartRunRequest {
	messages: ChatMessage[];
	mode?: AgentMode;
	model?: AIModelId;
	sessionId?: string;
	requestId: string;
}

export interface AgentRunnerClient {
	readonly state: AgentState;
	submitMessage(request: SubmitMessageRequest): Promise<{ sessionId: string; queued: boolean; started: boolean }>;
	removeQueuedMessage(sessionId: string, messageId: string): Promise<{ removed: boolean }>;
	startRun(request: StartRunRequest): Promise<{ sessionId: string }>;
	abortRun(sessionId?: string): Promise<void>;
	loadSession(sessionId: string): Promise<AiSession | undefined>;
	readSession(sessionId: string): Promise<AiSession | undefined>;
	listSessions(): Promise<Array<{ id: string; title: string; createdAt: number; isRunning: boolean }>>;
	searchSessions(query: string, limit?: number): Promise<Array<{ sessionId: string; role: string; content: string }>>;
	revertSession(sessionId: string, messageIndex: number): Promise<{ contextTokensUsed: number }>;
	renameSession(sessionId: string, title: string): Promise<void>;
	deleteSession(sessionId: string): Promise<void>;
	loadPendingChanges(): Promise<Record<string, PendingFileChange>>;
	savePendingChanges(changes: Record<string, PendingFileChange>): Promise<void>;
	listReviewEntries(): Promise<ReviewEntry[]>;
	updateReviewHunks(reviewId: string, hunkStatuses: PendingFileChange['hunkStatuses']): Promise<void>;
	resolveReviewEntry(reviewId: string, decision: 'accept' | 'reject'): Promise<void>;
	resolveReviewEntries(decision: 'accept' | 'reject', sessionId?: string, reviewIds?: string[]): Promise<void>;
	syncReviewPathFromWorkspace(path: string): Promise<void>;
	moveTrackedReviewPath(fromPath: string, toPath: string): Promise<void>;
	clearCurrentSession(sessionId?: string): Promise<void>;
	getRunningSessionIds(): Promise<string[]>;
}
