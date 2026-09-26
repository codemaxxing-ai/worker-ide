import type { AIModelId } from '../constants';

/**
 * Agent operating mode.
 * - code: Full tool access — reads, writes, edits, deletes files (default).
 * - plan: Read-only research + produces an implementation plan.
 * - ask: Read-only tools — conversational Q&A grounded in the codebase.
 */
export type AgentMode = 'code' | 'plan' | 'ask';

/**
 * Structured tool error info received via stream `tool_error` events.
 * Replaces regex-based `[CODE] message` prefix parsing on the frontend.
 */
export interface ToolErrorInfo {
	toolCallId: string;
	toolName: string;
	errorCode: string;
	errorMessage: string;
}

/**
 * Structured tool result info received via stream `tool_result` events.
 *
 * Each successful tool call emits this alongside its text output. The frontend
 * uses `title` for the collapsed label and `metadata` for rich rendering
 * (e.g. line stats, diagnostics, todo lists) instead of re-parsing raw strings.
 *
 * `metadata` is tool-specific — the UI inspects known fields per tool name.
 */
export interface ToolMetadataInfo {
	toolCallId: string;
	toolName: string;
	title: string;
	metadata: Record<string, unknown>;
}
export interface AiSession {
	id: string;
	title: string;
	titleGenerated?: boolean;
	createdAt: number;
	history: ChatMessage[];
	contextTokensUsed?: number;
	/** Set by the client after a revert to prevent the server-side stream
	 *  `finally` block from overwriting the truncated history. */
	revertedAt?: number;
	/** Structured tool result metadata keyed by toolCallId, persisted so loaded sessions
	 *  render the same rich UI (edit stats, line counts, etc.) as live-streamed ones. */
	toolMetadata?: Record<string, ToolMetadataInfo>;
	toolErrors?: Record<string, ToolErrorInfo>;
	/** Terminal status of the last agent run. Set by the agent-runner after
	 *  the loop finishes so reloaded sessions can restore the AgentError UI. */
	status?: AgentSessionStatus;
	errorMessage?: string;
	stopRequested?: boolean;
}
export interface AiSessionSummary {
	id: string;
	title: string;
	createdAt: number;
}
export type AgentSessionStatus = 'running' | 'completed' | 'error' | 'aborted';
export interface TodoItem {
	id: string;
	content: string;
	status: 'pending' | 'in_progress' | 'completed';
	priority: 'high' | 'medium' | 'low';
}

/**
 * A single part of a chat message.
 *
 * Messages are composed of parts to support mixed content: text interspersed
 * with tool calls, tool results, and model reasoning/thinking blocks.
 */
export interface TextPart {
	type: 'text';
	content: string;
}
export interface PreviewElementAttributes {
	id?: string;
	name?: string;
	alt?: string;
	title?: string;
	placeholder?: string;
	type?: string;
	href?: string;
	src?: string;
}
export interface PreviewElementReference {
	tagName: string;
	primarySelector: string;
	locatorCandidates: string[];
	containerSelector?: string;
	textPreview?: string;
	accessibleName?: string;
	role?: string;
	className?: string;
	attributes?: PreviewElementAttributes;
}
export interface PreviewElementPart extends PreviewElementReference {
	type: 'preview-element';
}
export interface ImagePart {
	type: 'image';
	/** Base64 data URL of the resized image (e.g. `data:image/webp;base64,...`). */
	url: string;
	mediaType: string;
	name?: string;
}
export interface ToolCallPart {
	type: 'tool-call';
	toolCallId: string;
	toolName: string;
	arguments: Record<string, unknown>;
}
export interface ToolResultPart {
	type: 'tool-result';
	toolCallId: string;
	toolName: string;
	result: string;
	isError?: boolean;
}
export interface ReasoningPart {
	type: 'reasoning';
	content: string;
}
export type UserMessagePart = TextPart | PreviewElementPart | ImagePart;
export type MessagePart = TextPart | PreviewElementPart | ImagePart | ToolCallPart | ToolResultPart | ReasoningPart;

/**
 * A single message in the AI chat conversation.
 *
 * App-owned message type that gives full control over the message format
 * without external dependency coupling.
 */
export interface ChatMessage {
	id: string;
	role: 'user' | 'assistant';
	parts: MessagePart[];
	authorUserId?: string;
	createdAt?: number;
	metadata?: {
		request?: {
			mode?: AgentMode;
			model?: AIModelId;
			state: 'queued' | 'committed';
		};
		snapshotId?: string;
	};
}
