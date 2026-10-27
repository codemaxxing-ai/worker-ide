import type {
	AgentSessionStatus,
	ChatMessage,
	PendingFileChange,
	ReviewEntry,
	ReviewSummary,
	ToolErrorInfo,
	ToolMetadataInfo,
} from './types';

export interface SessionParticipantProfile {
	name: string;
	image?: string;
	color: string;
}

/**
 * The top-level state shape for the AgentRunner Durable Object.
 * Auto-synced to all connected clients via the Agents SDK.
 */
export interface AgentState {
	currentSession: AgentSessionState | undefined;
	sessions: SessionSummary[];
	sessionParticipants: Record<string, SessionParticipantProfile>;
	reviewEntries: Record<string, ReviewEntry>;
	reviewSummary: ReviewSummary;
}

/**
 * State of the currently active AI session.
 *
 * Updated by the server during generation. The frontend renders this
 * directly — no bi-directional sync or skip-flags needed.
 */
export interface AgentSessionState {
	activeSubmissionId?: string;
	sessionId: string;
	title: string;
	status: AgentSessionStatus | 'idle';
	/** Messages belonging to the active turn and queued follow-ups only. */
	messages: ChatMessage[];
	/** Incremented after durable history changes so clients can refresh their snapshot. */
	historyVersion: number;
	statusText: string | undefined;
	error: { message: string; code?: string } | undefined;
	contextTokensUsed: number;
	pendingChanges: Record<string, PendingFileChange>;
	toolMetadata: Record<string, ToolMetadataInfo>;
	toolErrors: Record<string, ToolErrorInfo>;
	debugLogId: string | undefined;
	stopRequested: boolean;
	pendingQuestion: { question: string; options: string } | undefined;
	needsContinuation: boolean;
	doomLoopMessage: string | undefined;
	subAgentActivities: Record<string, SubAgentActivityRecord>;
	contextBlocksSummary?: Record<string, { description?: string; available?: boolean }>;
	extensions?: Array<{ name: string; description?: string; toolCount: number }>;
	/**
	 * True while a run is being recovered after a Durable Object restart (fiber
	 * recovery) and has not yet produced its first stream event. Lets the UI
	 * show a "recovering" affordance instead of appearing frozen.
	 */
	isRecovering?: boolean;
}

export interface SessionSummary {
	id: string;
	title: string;
	createdAt: number;
	isRunning: boolean;
}

/**
 * Events streamed to the client via @callable({ streaming: true }) during
 * an active generation. These are ephemeral (not persisted to state) and
 * provide real-time token-by-token content and status updates.
 *
 * The client processes these in the `onChunk` callback and uses them to
 * build the in-progress assistant message for display.
 */
export type StreamEvent =
	| ToolOutputEvent
	| TextDeltaEvent
	| ReasoningDeltaEvent
	| ToolCallStartEvent
	| ToolCallArgumentsDeltaEvent
	| ToolCallEndEvent
	| ToolResultEvent
	| ToolErrorEvent
	| StatusEvent
	| FileChangedEvent
	| SnapshotCreatedEvent
	| SnapshotDeletedEvent
	| UserQuestionEvent
	| ContextUtilizationEvent
	| UsageEvent
	| TurnCompleteEvent
	| SteeringMessageCommittedEvent
	| MaxIterationsReachedEvent
	| DoomLoopDetectedEvent
	| PlanCreatedEvent
	| RunFinishedEvent
	| RunErrorEvent
	| SubAgentActivityEvent;
export interface TextDeltaEvent {
	type: 'text-delta';
	delta: string;
}
export interface ToolOutputEvent {
	type: 'tool-output';
	submissionId: string;
	toolCallId: string;
	toolName: string;
	output: import('./command-output').CommandOutput;
}
export interface ReasoningDeltaEvent {
	type: 'reasoning-delta';
	delta: string;
}
export interface ToolCallStartEvent {
	type: 'tool-call-start';
	toolCallId: string;
	toolName: string;
	arguments?: Record<string, unknown>;
}
export interface ToolCallArgumentsDeltaEvent {
	type: 'tool-call-args-delta';
	toolCallId: string;
	delta: string;
}
export interface ToolCallEndEvent {
	type: 'tool-call-end';
	toolCallId: string;
	toolName: string;
	result: string;
	isError?: boolean;
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
export interface ContextUtilizationEvent {
	type: 'context-utilization';
	estimatedTokens: number;
	contextWindow: number;
	utilization: number;
}
export interface UsageEvent {
	type: 'usage';
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	turns: number;
	lastTurnInputTokens: number;
}
export interface TurnCompleteEvent {
	type: 'turn-complete';
}
export interface SteeringMessageCommittedEvent {
	type: 'steering-message-committed';
	id: string;
}
export interface MaxIterationsReachedEvent {
	type: 'max-iterations-reached';
	iterations: number;
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
export interface RunFinishedEvent {
	type: 'run-finished';
}
export interface RunErrorEvent {
	type: 'run-error';
	message: string;
	code?: string;
}

export interface SubAgentActivityEvent {
	type: 'sub-agent-activity';
	parentToolCallId: string;
	activity: SubAgentActivity;
}
export type SubAgentActivity =
	| { kind: 'tool-output'; event: ToolOutputEvent }
	| { kind: 'tool-start'; toolName: string }
	| { kind: 'tool-end'; toolName: string; toolCallId?: string; result?: string; isError?: boolean }
	| { kind: 'tool-metadata'; toolName: string; toolCallId?: string; title: string; metadata: Record<string, unknown> }
	| { kind: 'text-delta'; delta: string }
	| { kind: 'reasoning-delta'; delta: string }
	| { kind: 'debug-log'; debugLogId: string };
export interface SubAgentActivityRecord {
	outputTruncated?: boolean;
	tools: SubAgentToolEntry[];
	debugLogId: string | undefined;
	streamingText: string | undefined;
}
export interface SubAgentToolEntry {
	result?: string;
	toolCallId?: string;
	commandOutput?: import('./command-output').ToolCommandOutput;
	toolName: string;
	title: string;
	metadata: Record<string, unknown>;
	isError?: boolean;
}
export interface ToolErrorEvent {
	type: 'tool-error';
	toolCallId: string;
	toolName: string;
	errorCode: string;
	errorMessage: string;
}
