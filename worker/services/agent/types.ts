import type { CompletionReviewContext } from './completion-review';
import type { RequestOriginContext } from './request-origin-context';
import type { ToolFailureGuard } from './tool-failure-guard';
import type { ProjectFilesystem } from '../../durable/project-filesystem';
import type { LanguageModelV4FunctionTool } from '@ai-sdk/provider';
import type { AIModelId } from '@shared/constants';
import type { Agent } from 'agents';

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
 * Function to emit a stream event from a tool executor.
 * The owning turn drains observations into persisted tool metadata and workspace changes.
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
	reviewSubmissionId?: string;
	activeCodeMode?: { toolCallId: string; abortSignal?: AbortSignal };
	failureGuard?: ToolFailureGuard;
	onToolOutput?: (event: import('@shared/agent-state').ToolOutputEvent) => Promise<void>;
	abortSignal?: AbortSignal;
	callMcpTool: (serverId: string, toolName: string, arguments_: Record<string, unknown>) => Promise<string>;
	listMcpTools?: () => Promise<Array<{ serverId: string; name: string; description?: string; inputSchema: Record<string, unknown> }>>;
	beforeMutation?: () => void | Promise<void>;
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
	fsStub: DurableObjectStub<ProjectFilesystem>;
	model: AIModelId;
	requestOriginContext?: RequestOriginContext;
	readCompletionReviewContext?: () => Promise<CompletionReviewContext>;
	recordReviewObservation?: (toolName: string, input: unknown, output: unknown, failed?: boolean) => void;
	indexArtifact?: (entry: { key: string; content: string }) => Promise<void>;
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
