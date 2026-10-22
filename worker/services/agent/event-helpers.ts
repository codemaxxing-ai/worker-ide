import { TOOL_ERROR_LABELS, ToolExecutionError } from '@shared/tool-errors';

import type {
	FileChangedEvent,
	PlanCreatedEvent,
	SnapshotCreatedEvent,
	SnapshotDeletedEvent,
	StatusEvent,
	StreamEvent,
	SubAgentActivity,
	SubAgentActivityEvent,
	ToolResultEvent,
	ToolErrorEvent,
	UserQuestionEvent,
} from '@shared/agent-state';
import type { StepResult, ToolSet } from 'ai';

/** Keep the queue identity stable: tool senders retain a reference to this array. */
export function drainEventQueue(queue: StreamEvent[]): StreamEvent[] {
	return queue.splice(0);
}

export function createToolErrorEvent(toolCallId: string, toolName: string, error: unknown): ToolErrorEvent {
	const errorMessage = error instanceof Error ? error.message : String(error);
	const remoteCode = /^\[([A-Z_]+)\]/.exec(errorMessage)?.[1];
	return {
		type: 'tool-error',
		toolCallId,
		toolName,
		errorCode:
			error instanceof ToolExecutionError
				? error.code
				: remoteCode && Object.hasOwn(TOOL_ERROR_LABELS, remoteCode)
					? remoteCode
					: 'TOOL_EXECUTION_FAILED',
		errorMessage,
	};
}

/** Step content includes validation failures that never invoke the executor hook. */
export function toolErrorEvents(content: StepResult<ToolSet>['content']): StreamEvent[] {
	return content.flatMap<StreamEvent>((part) => {
		if (part.type !== 'tool-error') return [];
		const error = createToolErrorEvent(part.toolCallId, part.toolName, part.error);
		return [
			error,
			{ type: 'tool-call-end', toolCallId: part.toolCallId, toolName: part.toolName, result: error.errorMessage, isError: true },
		];
	});
}

function statusEvent(message: string): StatusEvent {
	return { type: 'status', message };
}

function toolResultEvent(toolCallId: string, toolName: string, title: string, metadata: Record<string, unknown>): ToolResultEvent {
	return { type: 'tool-result', toolCallId, toolName, title, metadata };
}

function fileChangedEvent(
	path: string,
	action: 'create' | 'edit' | 'delete' | 'move',
	beforeContent: string | undefined,
	afterContent: string | undefined,
	toolCallId: string | undefined,
): FileChangedEvent {
	return { type: 'file-changed', path, action, beforeContent, afterContent, toolCallId };
}

function snapshotCreatedEvent(id: string): SnapshotCreatedEvent {
	return { type: 'snapshot-created', id };
}

function snapshotDeletedEvent(id: string): SnapshotDeletedEvent {
	return { type: 'snapshot-deleted', id };
}

function userQuestionEvent(question: string, options: string): UserQuestionEvent {
	return { type: 'user-question', question, options };
}

function planCreatedEvent(path: string): PlanCreatedEvent {
	return { type: 'plan-created', path };
}

function subAgentActivityEvent(parentToolCallId: string, activity: SubAgentActivity): SubAgentActivityEvent {
	return { type: 'sub-agent-activity', parentToolCallId, activity };
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

const FILE_ACTIONS = new Set(['create', 'edit', 'delete', 'move']);
function entryType(value: unknown): 'file' | 'directory' | 'symlink' | undefined {
	return value === 'file' || value === 'directory' || value === 'symlink' ? value : undefined;
}
function isFileAction(value: unknown): value is 'create' | 'edit' | 'delete' | 'move' {
	return typeof value === 'string' && FILE_ACTIONS.has(value);
}

/**
 * Create a SendEvent function that pushes StreamEvent objects into a queue.
 *
 * The `toolCallIdReference` is a mutable ref set by the tool wrapper before
 * execution, allowing events to be auto-tagged with the current tool call ID.
 */
export function createSendEventFunction(
	queue: StreamEvent[],
	toolCallIdReference: { current: string | undefined },
	signal: AbortSignal,
): (type: string, data: Record<string, unknown>) => void {
	return (type: string, data: Record<string, unknown>) => {
		if (signal.aborted) return;

		const toolCallId = toolCallIdReference.current;

		// Map legacy event names to typed StreamEvent objects
		switch (type) {
			case 'status': {
				queue.push(statusEvent(String(data.message ?? '')));
				break;
			}
			case 'file_changed': {
				const action = isFileAction(data.action) ? data.action : 'edit';
				queue.push({
					...fileChangedEvent(
						String(data.path ?? ''),
						action,
						typeof data.beforeContent === 'string' ? data.beforeContent : undefined,
						typeof data.afterContent === 'string' ? data.afterContent : undefined,
						typeof data.tool_use_id === 'string' ? data.tool_use_id : toolCallId,
					),
					isBinary: data.isBinary === true,
					beforeBytes: typeof data.beforeBytes === 'string' ? data.beforeBytes : undefined,
					afterBytes: typeof data.afterBytes === 'string' ? data.afterBytes : undefined,
					entryType: entryType(data.entryType),
					beforeEntryType: entryType(data.beforeEntryType),
				});
				break;
			}
			case 'user_question': {
				queue.push(userQuestionEvent(String(data.question ?? ''), String(data.options ?? '')));
				break;
			}
			case 'snapshot_created': {
				queue.push(snapshotCreatedEvent(String(data.id ?? '')));
				break;
			}
			case 'snapshot_deleted': {
				queue.push(snapshotDeletedEvent(String(data.id ?? '')));
				break;
			}
			case 'plan_created': {
				queue.push(planCreatedEvent(String(data.path ?? '')));
				break;
			}
			case 'sub_agent_activity': {
				const parentId = typeof data.parentToolCallId === 'string' ? data.parentToolCallId : (toolCallId ?? '');
				const activity = data.activity;
				if (isRecordObject(activity) && typeof activity.kind === 'string') {
					// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- validated above
					queue.push(subAgentActivityEvent(parentId, activity as SubAgentActivity));
				}
				break;
			}
			default: {
				// For tool_result events, construct typed event
				if (type === 'tool_result') {
					const rawMetadata = data.metadata;
					const metadataRecord: Record<string, unknown> = isRecordObject(rawMetadata) ? rawMetadata : {};
					queue.push(
						toolResultEvent(
							typeof data.toolCallId === 'string' ? data.toolCallId : (toolCallId ?? ''),
							String(data.tool_name ?? ''),
							String(data.title ?? ''),
							metadataRecord,
						),
					);
				}
				break;
			}
		}
	};
}
