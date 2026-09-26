import { TOOL_ERROR_LABELS } from '@shared/tool-errors';

import { isRecord } from '../helpers';

import type { MessagePart, ReasoningPart, TextPart, ToolCallPart, ToolErrorInfo, ToolMetadataInfo, ToolResultPart } from '@shared/types';
import type { ToolName } from '@shared/validation';

export function isTextPart(part: MessagePart): part is TextPart {
	return part.type === 'text';
}

export function isToolCallPart(part: MessagePart): part is ToolCallPart {
	return part.type === 'tool-call';
}

export function isToolResultPart(part: MessagePart): part is ToolResultPart {
	return part.type === 'tool-result';
}

export function isReasoningPart(part: MessagePart): part is ReasoningPart {
	return part.type === 'reasoning';
}

/**
 * Check whether the tool result text represents an error.
 *
 * Error formats from the AI SDK:
 * - `[CODE] message` — ToolExecutionError thrown by our tool executors
 * - `Error executing tool: ...` — unexpected throw caught by the AI SDK
 * - `Input validation failed...` — Zod schema validation failure
 */
/**
 * Derive a short summary label for a completed tool call when structured
 * metadata is not available (e.g. loaded sessions where tool_result events
 * were not persisted).
 */
export function deriveCompletedLabel(toolName: ToolName | undefined, _rawContent: string | undefined): string {
	// codemode has no structured metadata summary; its label is always the same.
	if (toolName === 'codemode') return 'Ran code';
	return 'Completed';
}

function isErrorResult(text: string): boolean {
	return /^\[[A-Z_]+\] /.test(text) || text.startsWith('Error executing tool:') || text.startsWith('Input validation failed');
}
const errorLabels: Record<string, string> = TOOL_ERROR_LABELS;

/**
 * Get a short label from a structured ToolErrorInfo.
 * Uses the typed errorCode directly instead of regex-parsing `[CODE] message`.
 */
export function shortenErrorFromStructured(error: ToolErrorInfo): string {
	if (error.errorCode) {
		const label = errorLabels[error.errorCode];
		if (label) return label;
	}
	// Strip the [CODE] prefix from errorMessage if present (ToolExecutionError format)
	const stripped = error.errorMessage.replace(/^\[[A-Z_]+\] /, '');
	return stripped.length > 40 ? stripped.slice(0, 40) + '...' : stripped || 'Error';
}

/**
 * Build a brief summary from structured metadata (CUSTOM tool_result event).
 * Returns undefined if no meaningful summary can be derived, so the caller
 * falls back to raw-parsing.
 */
export function summarizeFromMetadata(toolName: ToolName | undefined, info: ToolMetadataInfo): string | undefined {
	const { metadata } = info;

	switch (toolName) {
		case 'lint_check': {
			if (typeof metadata.issueCount === 'number') {
				if (metadata.issueCount === 0) return 'No issues';
				return `${metadata.issueCount} issue${metadata.issueCount === 1 ? '' : 's'}`;
			}
			return undefined;
		}

		case 'lint_fix': {
			return 'Fixed';
		}

		case 'dependencies_list': {
			if (isRecord(metadata.dependencies)) {
				const count = Object.keys(metadata.dependencies).length;
				return `${count} dep${count === 1 ? '' : 's'}`;
			}
			return undefined;
		}

		case 'dependencies_update': {
			if (typeof metadata.action === 'string' && typeof metadata.name === 'string') {
				const verb = metadata.action === 'add' ? 'Added' : metadata.action === 'remove' ? 'Removed' : 'Updated';
				return `${verb} ${metadata.name}`;
			}
			return undefined;
		}

		case 'asset_settings_get': {
			return 'Retrieved';
		}

		case 'asset_settings_update': {
			return Array.isArray(metadata.changes) && metadata.changes.length > 0 ? `${metadata.changes.length} changed` : 'No changes';
		}

		case 'bindings_get': {
			return 'Retrieved';
		}

		case 'bindings_update': {
			return Array.isArray(metadata.changes) && metadata.changes.length > 0 ? `${metadata.changes.length} changed` : 'No changes';
		}

		case 'plan_update': {
			if (typeof metadata.completedTasks === 'number' && typeof metadata.totalTasks === 'number') {
				return `${metadata.completedTasks}/${metadata.totalTasks}`;
			}
			return undefined;
		}

		case 'todos_get': {
			return 'Retrieved';
		}

		case 'todos_update': {
			if (Array.isArray(metadata.todos)) {
				const todos = metadata.todos.filter((item) => isTodoItemDisplay(item));
				if (todos.length > 0) return summarizeTodos(todos);
			}
			return undefined;
		}

		case 'web_fetch': {
			if (typeof metadata.contentLength === 'number') {
				return `${metadata.contentLength} chars`;
			}
			return undefined;
		}

		case 'docs_search': {
			return 'Results fetched';
		}

		case 'cdp_eval': {
			if (typeof metadata.method === 'string') {
				return metadata.method;
			}
			return 'Legacy browser debug';
		}

		case 'browser_execute': {
			return 'Browser run';
		}

		case 'browser_markdown': {
			return 'Read as Markdown';
		}

		case 'browser_extract': {
			return 'Extracted data';
		}

		case 'browser_links': {
			return 'Listed links';
		}

		case 'browser_scrape': {
			return 'Scraped elements';
		}

		case 'test_run': {
			if (typeof metadata.passed === 'number' && typeof metadata.failed === 'number') {
				if (metadata.failed === 0) return `${metadata.passed} passed`;
				return `${metadata.failed} failed, ${metadata.passed} passed`;
			}
			return undefined;
		}

		case 'image_generate': {
			if (typeof metadata.sizeKilobytes === 'string') {
				return `Generated (${metadata.sizeKilobytes} KB)`;
			}
			return 'Generated';
		}

		case 'sub_agent': {
			if (typeof metadata.iterations === 'number') {
				return `${metadata.iterations} turn${metadata.iterations === 1 ? '' : 's'}`;
			}
			return 'Completed';
		}

		case 'user_question': {
			return undefined;
		}

		case 'bash': {
			if (typeof metadata.exitCode === 'number') {
				return metadata.exitCode === 0 ? 'Done' : `Exit ${metadata.exitCode}`;
			}
			return undefined;
		}

		case 'codemode': {
			return 'Executed';
		}

		default: {
			return undefined;
		}
	}
}

export interface TodoItemDisplay {
	id: string;
	content: string;
	status: 'pending' | 'in_progress' | 'completed';
	priority: 'high' | 'medium' | 'low';
}

export function isTodoItemDisplay(item: unknown): item is TodoItemDisplay {
	return (
		isRecord(item) &&
		typeof item.id === 'string' &&
		typeof item.content === 'string' &&
		(item.status === 'pending' || item.status === 'in_progress' || item.status === 'completed') &&
		(item.priority === 'high' || item.priority === 'medium' || item.priority === 'low')
	);
}

export function parseTodosFromRawResult(rawResult: string | undefined): TodoItemDisplay[] | undefined {
	if (!rawResult) return undefined;
	try {
		const parsed: unknown = JSON.parse(rawResult);
		if (Array.isArray(parsed)) {
			return parsed.filter((item) => isTodoItemDisplay(item));
		}
		if (isRecord(parsed) && Array.isArray(parsed.todos)) {
			return parsed.todos.filter((item) => isTodoItemDisplay(item));
		}
	} catch {
		// Not JSON
	}
	return undefined;
}

function summarizeTodos(todos: TodoItemDisplay[]): string {
	const completed = todos.filter((item) => item.status === 'completed').length;
	return `${completed}/${todos.length} completed`;
}

export function stringifyConfigValue(value: unknown): string {
	if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '[]';
	if (typeof value === 'boolean') return value ? 'enabled' : 'disabled';
	if (typeof value === 'string') return value;
	return value === undefined ? 'default' : String(value);
}

export function getAssetSettingsEntries(metadata: Record<string, unknown> | undefined): Array<{ key: string; value: unknown }> | undefined {
	const settings = metadata && isRecord(metadata.assetSettings) ? metadata.assetSettings : undefined;
	if (!settings) return undefined;
	return [
		{ key: 'not_found_handling', value: settings.not_found_handling },
		{ key: 'html_handling', value: settings.html_handling },
		{ key: 'run_worker_first', value: settings.run_worker_first },
	];
}

export function getBindingsEntries(metadata: Record<string, unknown> | undefined): Array<{ key: string; value: unknown }> | undefined {
	const bindingsConfig = metadata && isRecord(metadata.bindingsConfig) ? metadata.bindingsConfig : undefined;
	if (!bindingsConfig) return undefined;
	return [{ key: 'storage', value: bindingsConfig.storage === true }];
}

/**
 * Extract the `result` string from a structured tool result JSON.
 * Used by the expandable detail view to display the human-readable diff/summary.
 */
function extractResultField(rawResult: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(rawResult);
		if (isRecord(parsed) && typeof parsed.result === 'string') {
			return parsed.result;
		}
	} catch {
		// Not JSON
	}
	return undefined;
}

/**
 * Format raw tool result content for the expandable detail view.
 * Strips XML tags and formats per-tool content cleanly.
 */
function formatToolResultDetail(toolName: ToolName, rawResult: string): string {
	// Errors are plain text — return as-is
	if (isErrorResult(rawResult)) {
		return rawResult;
	}

	switch (toolName) {
		case 'lint_fix': {
			// Returns { result: "diff...", linesAdded, ... }
			// Show the diff/result text (fallback for when InlineDiffView is unavailable, e.g. page reload)
			return extractResultField(rawResult) ?? rawResult;
		}

		case 'plan_update': {
			// Returns { result: "summary..." }
			return extractResultField(rawResult) ?? rawResult;
		}

		case 'dependencies_list': {
			// JSON with { dependencies: { name: version } }
			try {
				const parsed: unknown = JSON.parse(rawResult);
				if (isRecord(parsed) && isRecord(parsed.dependencies)) {
					const entries = Object.entries(parsed.dependencies);
					if (entries.length === 0) {
						return typeof parsed.note === 'string' ? parsed.note : 'No dependencies';
					}
					return entries.map(([name, version]) => `${name}: ${String(version)}`).join('\n');
				}
			} catch {
				// Not JSON
			}
			return rawResult;
		}

		case 'dependencies_update': {
			// JSON with { success, action, name, dependencies }
			try {
				const parsed: unknown = JSON.parse(rawResult);
				if (isRecord(parsed) && typeof parsed.action === 'string' && typeof parsed.name === 'string') {
					const verb = parsed.action === 'add' ? 'Added' : parsed.action === 'remove' ? 'Removed' : 'Updated';
					let summary = `${verb} ${parsed.name}`;
					if (isRecord(parsed.dependencies)) {
						const version = parsed.dependencies[parsed.name];
						if (typeof version === 'string') summary += `@${version}`;
					}
					return summary;
				}
			} catch {
				// Not JSON
			}
			return rawResult;
		}

		case 'web_fetch': {
			// JSON with { url, content, length }
			try {
				const parsed: unknown = JSON.parse(rawResult);
				if (isRecord(parsed) && typeof parsed.content === 'string') {
					const url = typeof parsed.url === 'string' ? `Source: ${parsed.url}\n\n` : '';
					return `${url}${parsed.content}`;
				}
			} catch {
				// Not JSON
			}
			return rawResult;
		}

		case 'docs_search': {
			// JSON with { results: ... }
			try {
				const parsed: unknown = JSON.parse(rawResult);
				if (isRecord(parsed)) {
					return JSON.stringify(parsed, undefined, 2);
				}
			} catch {
				// Not JSON
			}
			return rawResult;
		}

		case 'cdp_eval': {
			try {
				const parsed: unknown = JSON.parse(rawResult);
				if (isRecord(parsed)) {
					const method = typeof parsed.method === 'string' ? `Method: ${parsed.method}\n\n` : '';
					const result = parsed.result === undefined ? 'No result' : JSON.stringify(parsed.result, undefined, 2);
					return `${method}${result}`;
				}
			} catch {
				// Not JSON
			}
			return rawResult;
		}

		case 'browser_execute':
		case 'browser_markdown':
		case 'browser_extract':
		case 'browser_links':
		case 'browser_scrape': {
			return rawResult;
		}

		case 'codemode': {
			// Codemode returns { result, error?, logs? }. Surface console logs and
			// the return value legibly instead of dumping the raw envelope.
			try {
				const parsed: unknown = JSON.parse(rawResult);
				if (isRecord(parsed) && ('logs' in parsed || 'result' in parsed || 'error' in parsed)) {
					const sections: string[] = [];
					if (Array.isArray(parsed.logs) && parsed.logs.length > 0) {
						const logText = parsed.logs.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n');
						sections.push(`Console:\n${logText}`);
					}
					if (typeof parsed.error === 'string' && parsed.error) {
						sections.push(`Error: ${parsed.error}`);
					}
					if (parsed.result !== undefined && parsed.result !== null) {
						const resultText = typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result, undefined, 2);
						if (resultText && resultText !== '""') {
							sections.push(`Result:\n${resultText}`);
						}
					}
					if (sections.length > 0) {
						return sections.join('\n\n');
					}
				}
			} catch {
				// Not JSON — fall through to raw
			}
			return rawResult;
		}

		case 'user_question': {
			// JSON with { question, options, message }
			try {
				const parsed: unknown = JSON.parse(rawResult);
				if (isRecord(parsed) && typeof parsed.question === 'string') {
					return parsed.question;
				}
			} catch {
				// Not JSON
			}
			return rawResult;
		}

		case 'todos_get':
		case 'todos_update': {
			// Handled by InlineTodoList — just return a summary
			try {
				const parsed: unknown = JSON.parse(rawResult);
				if (isRecord(parsed) && Array.isArray(parsed.todos)) {
					const completed = parsed.todos.filter((t): t is Record<string, unknown> => isRecord(t) && t.status === 'completed').length;
					return `${completed}/${parsed.todos.length} tasks completed`;
				}
			} catch {
				// Not JSON
			}
			return rawResult;
		}

		case 'sub_agent': {
			return rawResult;
		}

		default: {
			// Try JSON pretty-print, fall back to raw
			try {
				const parsed: unknown = JSON.parse(rawResult);
				return JSON.stringify(parsed, undefined, 2);
			} catch {
				return rawResult;
			}
		}
	}
}

/**
 * Build the detail text shown in the expandable dropdown.
 * Combines raw result content with structured error info when available.
 */
export function getExpandableDetailText(
	toolName: ToolName,
	rawResultContent: string | undefined,
	structuredError: ToolErrorInfo | undefined,
): string {
	const parts: string[] = [];
	if (structuredError) {
		const prefix = structuredError.errorCode ? `[${structuredError.errorCode}] ` : '';
		parts.push(`${prefix}${structuredError.errorMessage}`);
	}
	if (rawResultContent) {
		const formatted = formatToolResultDetail(toolName, rawResultContent);
		// Avoid duplicating the error message if it's the same as the structured error
		if (!structuredError || formatted !== parts[0]) {
			parts.push(formatted);
		}
	}
	return parts.join('\n\n');
}

/**
 * Unwrap a tool result from its `{ content: string }` envelope.
 *
 * Tool results use a `{ content: text }` envelope format for consistent
 * parsing by the AI SDK. The result arrives on the client as a JSON string
 * `'{"content":"..."}'` that this helper unwraps.
 */
function unwrapToolContent(value: unknown): string | undefined {
	if (typeof value === 'string') {
		try {
			const parsed: unknown = JSON.parse(value);
			if (isRecord(parsed) && typeof parsed.content === 'string') {
				return parsed.content;
			}
			// The AI SDK wraps tool execution errors as {"error":"..."}
			if (isRecord(parsed) && typeof parsed.error === 'string') {
				return parsed.error;
			}
		} catch {
			// Not JSON
		}
		return value || undefined;
	}
	if (isRecord(value) && typeof value.content === 'string') {
		return value.content;
	}
	if (isRecord(value) && typeof value.error === 'string') {
		return value.error;
	}
	return value === undefined ? undefined : JSON.stringify(value);
}

/**
 * Get the raw result string from a ToolCallPart and/or ToolResultPart.
 * The result is in ToolResultPart.result (string).
 */
export function getToolResultContent(toolResult?: ToolResultPart): string | undefined {
	if (toolResult && typeof toolResult.result === 'string' && toolResult.result) {
		return unwrapToolContent(toolResult.result);
	}
	return undefined;
}
export function isToolError(toolResult?: ToolResultPart): boolean {
	if (toolResult?.isError) return true;
	const content = getToolResultContent(toolResult);
	return content !== undefined && isErrorResult(content);
}
