import type { CompletionReviewContext } from './completion-review';
import type { RequestOriginContext } from './request-origin-context';
import type { ToolFailureGuard } from './tool-failure-guard';
import type { ProjectFilesystem } from '../../durable/project-filesystem';
import type { LanguageModelV4FunctionTool } from '@ai-sdk/provider';
import type { ExtensionManager } from '@cloudflare/think/extensions';
import type { StreamEvent } from '@shared/agent-state';
import type { AIModelId } from '@shared/constants';
import type { ChatMessage, PendingFileChange, ToolErrorInfo, ToolMetadataInfo } from '@shared/types';
import type { Agent } from 'agents';
import type { Session } from 'agents/experimental/memory/session';
export type { ModelMessage } from 'ai';

export interface FileChange {
	path: string;
	action: 'create' | 'edit' | 'delete';
	beforeContent: string | Uint8Array | undefined;
	afterContent: string | Uint8Array | undefined;
	isBinary: boolean;
	entryType?: 'file' | 'directory' | 'symlink';
	beforeEntryType?: 'file' | 'directory' | 'symlink';
}

export interface SnapshotMetadata {
	id: string;
	timestamp: number;
	label: string;
	sessionId?: string;
	changes: Array<{
		path: string;
		action: 'create' | 'edit' | 'delete';
		isBinary?: boolean;
		entryType?: 'file' | 'directory' | 'symlink';
		beforeEntryType?: 'file' | 'directory' | 'symlink';
	}>;
}

export type TodoItem = {
	id: string;
	content: string;
	status: 'pending' | 'in_progress' | 'completed';
	priority: 'high' | 'medium' | 'low';
};

/**
 * A queue of stream events that tools push into during execution.
 * The stream wrapper drains this queue between LLM events.
 */
export type StreamEventQueue = StreamEvent[];

/**
 * A record of a tool execution failure, pushed by createServerTools
 * and consumed by the agent loop for doom-loop detection.
 */
export interface ToolFailureRecord {
	toolName: string;
	errorCode: string | undefined;
	errorMessage: string;
}

/**
 * A queue of tool failure records. createServerTools pushes into this
 * during execution; the agent loop drains it after each tool call ends.
 */
export type ToolFailureQueue = ToolFailureRecord[];

/**
 * Mutable ref holding the toolCallId of the currently-executing tool.
 * Set by the tool wrapper before execution, read by `createSendEvent`
 * to auto-inject toolCallId into events (tool_result, file_changed).
 */
export interface ToolCallIdReference {
	current: string | undefined;
}

/**
 * Ordered queue of toolCallIds from completed tool calls.
 * Each tool wrapper `shift()`s the next ID before executing.
 */
export type PendingToolCallIds = string[];

/**
 * Function to emit a stream event from a tool executor.
 * Pushes events into the shared StreamEventQueue which is drained
 * by the stream wrapper and sent to the client.
 */
export type SendEventFunction = (type: string, data: Record<string, unknown>) => void;

/**
 * Minimal browser binding shape used by the browser tooling.
 *
 * The generated `BROWSER` binding type in this project exposes `fetch`, while
 * the global `Fetcher` type in workerd also includes `connect()`. The browser
 * tools only need `fetch()`, so we model the narrower contract here and adapt
 * it to `Fetcher` at the integration boundary.
 */
export interface BrowserBinding {
	fetch: Fetcher['fetch'];
}

/**
 * Context passed to tool execute functions.
 * This is captured in closures when creating tool definitions.
 */
export interface ToolExecutorContext {
	projectRoot: string;
	projectId: string;
	organizationId?: string;
	mode: 'code' | 'plan' | 'ask';
	sessionId?: string;
	userId?: string;
	/**
	 * The current tool call's ID (supplied by the AI SDK at execute time).
	 * Used for deterministic sub-resource naming so durable work can be
	 * re-attached rather than re-run after a Durable Object restart.
	 */
	toolCallId?: string;
	toolName?: string;
	submissionId?: string;
	activeCodeMode?: { toolCallId: string; abortSignal?: AbortSignal };
	failureGuard?: ToolFailureGuard;
	onToolOutput?: (event: import('@shared/agent-state').ToolOutputEvent) => Promise<void>;
	session?: Session;
	abortSignal?: AbortSignal;
	callMcpTool: (serverId: string, toolName: string, arguments_: Record<string, unknown>) => Promise<string>;
	isSubAgent?: boolean;
	/**
	 * Durable Object state of the agent that owns this run. The codemode
	 * runtime backing the browser/execute tools lives in a facet of this DO,
	 * so it must be provided to create those tools.
	 */
	ctx?: DurableObjectState;
	loader?: WorkerLoader;
	browser?: BrowserBinding;
	agentReference?: Agent<Env, unknown>;
	extensionManager?: ExtensionManager;
	fsStub: DurableObjectStub<ProjectFilesystem>;
	model: AIModelId;
	requestOriginContext?: RequestOriginContext;
	readCompletionReviewContext?: () => Promise<CompletionReviewContext>;
	recordReviewObservation?: (toolName: string, input: unknown, output: unknown, failed?: boolean) => void;
	indexArtifact?: (entry: { key: string; content: string }) => Promise<void>;
}

export interface SessionPersistData {
	createdAt: number;
	title?: string;
	history: ChatMessage[];
	contextTokensUsed?: number;
	toolMetadata?: Record<string, ToolMetadataInfo>;
	toolErrors?: Record<string, ToolErrorInfo>;
	error?: { message: string; code?: string };
	pendingChanges?: Record<string, PendingFileChange>;
}

/**
 * Unified tool result format. All tool execute functions must return this shape.
 *
 * - `title`:    Short label for the collapsed tool row in the UI
 *               (e.g. relative file path, glob pattern, package name).
 * - `metadata`: Tool-specific structured data for rich UI rendering.
 *               Sent to the frontend via a `tool-result` stream event.
 * - `output`:   Plain-text result that goes back to the LLM context.
 */
export interface ToolResult<M extends Record<string, unknown> = Record<string, unknown>> {
	title: string;
	metadata: M;
	output: string;
}

/**
 * Tool execute function signature.
 * Used by individual tool modules, wrapped into Vercel AI SDK tools by tools/index.ts.
 */
export type ToolExecuteFunction = (
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
	queryChanges?: FileChange[],
) => Promise<ToolResult>;

/**
 * Tool definition shape used by individual tool modules.
 * The tools/index.ts barrel wraps these into Vercel AI SDK tool() format.
 */
export interface ToolJsonSchema {
	type?: LanguageModelV4FunctionTool['inputSchema']['type'];
	description?: string;
	properties?: Record<string, ToolJsonSchema | boolean>;
	items?: ToolJsonSchema | boolean;
	required?: string[];
	additionalProperties?: ToolJsonSchema | boolean;
	enum?: NonNullable<LanguageModelV4FunctionTool['inputSchema']['enum']>;
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
	minItems?: number;
	maxItems?: number;
	pattern?: string;
}

export interface ToolDefinition {
	name: string;
	description: string;
	input_schema: ToolJsonSchema & { type: 'object'; properties: Record<string, ToolJsonSchema | boolean> };
}

export interface ToolModule {
	definition: ToolDefinition;
	execute: ToolExecuteFunction;
}

export type { AgentDebugLog, AgentDebugLogSummary, AgentLogEntry, LogCategory, LogLevel } from './agent-logger';
