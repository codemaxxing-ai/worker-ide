import type { ReviewEntry, ReviewSummary } from './types';

/**
 * The top-level state shape for the ProjectAgent Durable Object.
 * Auto-synced to all connected clients via the Agents SDK.
 */
export interface AgentState {
	ready: boolean;
	setupError?: string;
	sessions: SessionSummary[];
	reviewEntries: Record<string, ReviewEntry>;
	reviewSummary: ReviewSummary;
}

export interface SessionSummary {
	id: string;
	title: string;
	createdAt: number;
	isRunning: boolean;
	updatedAt: number;
	model: import('./constants').AIModelId;
	mode: import('./types').AgentMode;
	status: 'idle' | 'running' | 'completed' | 'error' | 'aborted';
	revision: number;
	finalizing?: boolean;
	titleGenerated?: boolean;
}

/** Application tool observations; transcript and task streaming are owned by Think. */
export type StreamEvent =
	| ToolOutputEvent
	| ToolResultEvent
	| ToolErrorEvent
	| StatusEvent
	| FileChangedEvent
	| SnapshotCreatedEvent
	| SnapshotDeletedEvent
	| UserQuestionEvent
	| DoomLoopDetectedEvent
	| PlanCreatedEvent;
export interface ToolOutputEvent {
	type: 'tool-output';
	submissionId: string;
	toolCallId: string;
	toolName: string;
	output: import('./command-output').CommandOutput;
}
export interface ToolResultEvent {
	type: 'tool-result';
	toolCallId: string;
	toolName: string;
	title: string;
	metadata: Record<string, unknown>;
}
export interface StatusEvent {
	type: 'status';
	message: string;
}
export interface FileChangedEvent {
	type: 'file-changed';
	path: string;
	action: 'create' | 'edit' | 'delete' | 'move';
	beforeContent: string | undefined;
	afterContent: string | undefined;
	toolCallId: string | undefined;
	isBinary?: boolean;
	beforeBytes?: string;
	afterBytes?: string;
	entryType?: 'file' | 'directory' | 'symlink';
	beforeEntryType?: 'file' | 'directory' | 'symlink';
}
export interface SnapshotCreatedEvent {
	type: 'snapshot-created';
	id: string;
}
export interface SnapshotDeletedEvent {
	type: 'snapshot-deleted';
	id: string;
}
export interface UserQuestionEvent {
	type: 'user-question';
	question: string;
	options: string;
}
export interface DoomLoopDetectedEvent {
	type: 'doom-loop-detected';
	reason: string;
	toolName: string | undefined;
	message: string;
}
export interface PlanCreatedEvent {
	type: 'plan-created';
	path: string;
}
export interface ToolErrorEvent {
	type: 'tool-error';
	toolCallId: string;
	toolName: string;
	errorCode: string;
	errorMessage: string;
}
