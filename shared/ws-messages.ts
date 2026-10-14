import { z } from 'zod';

import { runtimeStatusSchema } from './runtime-status';

import type { PreviewUpdateTarget } from './preview-path';
import type { RuntimeStatus } from './runtime-status';
import type { CursorPosition, Participant, SelectionRange, ServerError, ServerLogEntry } from './types';
export interface PingMessage {
	type: 'ping';
}
export interface CollabJoinMessage {
	type: 'collab-join';
}
export interface CursorUpdateMessage {
	type: 'cursor-update';
	file?: string;
	cursor?: CursorPosition;
	selection?: SelectionRange;
}
export interface FileEditMessage {
	type: 'file-edit';
	path: string;
	content: string;
	cursor?: CursorPosition;
	selection?: SelectionRange;
}

/**
 * Client message sent by the HMR client after connecting (or reconnecting
 * post-reload). Includes the last update version the client has seen so the
 * coordinator can determine whether the client missed any updates.
 *
 * The version is a monotonically increasing integer maintained by the
 * coordinator. A value of 0 means "I have never seen an update".
 */
export interface HmrConnectMessage {
	type: 'hmr-connect';
	version: number;
}

/**
 * Client message to sync the IDE output logs (errors, warnings) to the coordinator.
 * Sent periodically by the frontend so the AI agent loop can read fresh logs
 * between iterations without needing a round-trip to the browser.
 */
export interface OutputLogsSyncMessage {
	type: 'output-logs-sync';
	logs: string;
}

export type ClientMessage =
	PingMessage | CollabJoinMessage | CursorUpdateMessage | FileEditMessage | HmrConnectMessage | OutputLogsSyncMessage;
export interface PongMessage {
	type: 'pong';
}
export interface CollabStateMessage {
	type: 'collab-state';
	selfId: string;
	selfColor: string;
	participants: Participant[];
}
export interface ParticipantJoinedMessage {
	type: 'participant-joined';
	participant: Participant;
}
export interface ParticipantLeftMessage {
	type: 'participant-left';
	id: string;
}
export interface CursorUpdatedMessage {
	type: 'cursor-updated';
	id: string;
	color: string;
	file?: string;
	cursor?: CursorPosition;
	selection?: SelectionRange;
}
export interface FileEditedMessage {
	type: 'file-edited';
	id: string;
	path: string;
	content: string;
	cursor?: CursorPosition;
	selection?: SelectionRange;
}
export type HmrUpdateType = 'update' | 'full-reload';

export type HmrUpdateTargetMessage = PreviewUpdateTarget;

/**
 * HMR update message.
 *
 * `version` is a monotonically increasing integer assigned by the
 * coordinator. Clients track the latest version they have seen and
 * send it back on reconnect so the coordinator can detect missed updates.
 */
export interface HmrUpdateMessage {
	type: 'update' | 'full-reload';
	version: number;
	updates: Array<{
		type: HmrUpdateType;
		path: string;
		timestamp: number;
		targets: HmrUpdateTargetMessage[];
	}>;
}
export interface ServerErrorMessage {
	type: 'server-error';
	error: ServerError;
}
export interface ServerLogsMessage {
	type: 'server-logs';
	logs: ServerLogEntry[];
}

/**
 * Server message indicating git status may have changed.
 * Prompts clients to re-fetch git status data.
 */
export interface GitStatusChangedMessage {
	type: 'git-status-changed';
}

/**
 * Server message carrying test run results.
 * Broadcast when any collaborator runs tests so all clients
 * can update their local state without needing a server-side cache.
 */
export interface TestResultsChangedMessage {
	type: 'test-results-changed';
	results: {
		title: string;
		output: string;
		metadata: {
			passed: number;
			failed: number;
			total: number;
			files: number;
			bundleErrors: number;
		};
		fileResults: Array<{
			file: string;
			results: {
				suites: Array<{
					name: string;
					tests: Array<{
						name: string;
						status: 'passed' | 'failed';
						error?: string;
						duration: number;
					}>;
					passed: number;
					failed: number;
				}>;
				passed: number;
				failed: number;
				total: number;
				duration: number;
				error?: string;
			};
		}>;
		bundleErrors: Array<{ file: string; error: string }>;
		timestamp: number;
	};
	testName?: string;
	pattern?: string;
}

export type ServerMessage =
	| { type: 'runtime-status'; status: RuntimeStatus }
	| PongMessage
	| CollabStateMessage
	| ParticipantJoinedMessage
	| ParticipantLeftMessage
	| CursorUpdatedMessage
	| FileEditedMessage
	| HmrUpdateMessage
	| ServerErrorMessage
	| ServerLogsMessage
	| GitStatusChangedMessage
	| TestResultsChangedMessage;

const cursorPositionSchema = z.object({
	line: z.number(),
	ch: z.number(),
});

const selectionRangeSchema = z.object({
	anchor: cursorPositionSchema,
	head: cursorPositionSchema,
});

// Client message schemas
export const clientMessageSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('ping') }),
	z.object({ type: z.literal('collab-join') }),
	z.object({
		type: z.literal('cursor-update'),
		file: z.string().optional(),
		cursor: cursorPositionSchema.optional(),
		selection: selectionRangeSchema.optional(),
	}),
	z.object({
		type: z.literal('file-edit'),
		path: z.string(),
		content: z.string(),
		cursor: cursorPositionSchema.optional(),
		selection: selectionRangeSchema.optional(),
	}),
	z.object({
		type: z.literal('hmr-connect'),
		version: z.number(),
	}),
	z.object({
		type: z.literal('output-logs-sync'),
		logs: z.string(),
	}),
]);

// Server message schemas (for client-side validation)
const participantSchema = z.object({
	id: z.string(),
	color: z.string(),
	file: z.string().optional(),
	cursor: cursorPositionSchema.optional(),
	selection: selectionRangeSchema.optional(),
});

const dependencyErrorSchema = z.object({
	packageName: z.string(),
	code: z.enum(['unregistered', 'not-found', 'resolve-failed']),
	message: z.string(),
});

const sourceLocationSchema = z.object({
	file: z.string(),
	line: z.number().optional(),
	column: z.number().optional(),
});

const serverErrorSchema = z.object({
	id: z.string(),
	timestamp: z.number(),
	type: z.enum(['bundle', 'runtime']),
	message: z.string(),
	location: sourceLocationSchema.optional(),
	dependencyErrors: z.array(dependencyErrorSchema).optional(),
});

const serverLogSchema = z.object({
	type: z.literal('server-log'),
	timestamp: z.number(),
	level: z.enum(['log', 'warning', 'error', 'debug', 'info']),
	message: z.string(),
	location: sourceLocationSchema.optional(),
});

const hmrUpdateSchema = z.object({
	type: z.enum(['update', 'full-reload']),
	path: z.string(),
	timestamp: z.number(),
	targets: z.array(
		z.object({
			id: z.string(),
			kind: z.enum(['module', 'style-link']),
		}),
	),
});

export const serverMessageSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('runtime-status'), status: runtimeStatusSchema }),
	z.object({ type: z.literal('pong') }),
	z.object({
		type: z.literal('collab-state'),
		selfId: z.string(),
		selfColor: z.string(),
		participants: z.array(participantSchema),
	}),
	z.object({
		type: z.literal('participant-joined'),
		participant: participantSchema,
	}),
	z.object({
		type: z.literal('participant-left'),
		id: z.string(),
	}),
	z.object({
		type: z.literal('cursor-updated'),
		id: z.string(),
		color: z.string(),
		file: z.string().optional(),
		cursor: cursorPositionSchema.optional(),
		selection: selectionRangeSchema.optional(),
	}),
	z.object({
		type: z.literal('file-edited'),
		id: z.string(),
		path: z.string(),
		content: z.string(),
		cursor: cursorPositionSchema.optional(),
		selection: selectionRangeSchema.optional(),
	}),
	z.object({
		type: z.literal('update'),
		version: z.number(),
		updates: z.array(hmrUpdateSchema),
	}),
	z.object({
		type: z.literal('full-reload'),
		version: z.number(),
		updates: z.array(hmrUpdateSchema),
	}),
	z.object({
		type: z.literal('server-error'),
		error: serverErrorSchema,
	}),
	z.object({
		type: z.literal('server-logs'),
		logs: z.array(serverLogSchema),
	}),
	z.object({
		type: z.literal('git-status-changed'),
	}),
	z.object({
		type: z.literal('test-results-changed'),
		results: z.object({
			title: z.string(),
			output: z.string(),
			metadata: z.object({
				passed: z.number(),
				failed: z.number(),
				total: z.number(),
				files: z.number(),
				bundleErrors: z.number(),
			}),
			fileResults: z.array(
				z.object({
					file: z.string(),
					results: z.object({
						suites: z.array(
							z.object({
								name: z.string(),
								tests: z.array(
									z.object({
										name: z.string(),
										status: z.enum(['passed', 'failed']),
										error: z.string().optional(),
										duration: z.number(),
									}),
								),
								passed: z.number(),
								failed: z.number(),
							}),
						),
						passed: z.number(),
						failed: z.number(),
						total: z.number(),
						duration: z.number(),
						error: z.string().optional(),
					}),
				}),
			),
			bundleErrors: z.array(z.object({ file: z.string(), error: z.string() })),
			timestamp: z.number(),
		}),
		testName: z.string().optional(),
		pattern: z.string().optional(),
	}),
]);
export function serializeMessage(message: ClientMessage | ServerMessage): string {
	return JSON.stringify(message);
}
export function parseClientMessage(data: string): { success: true; data: ClientMessage } | { success: false; error: string } {
	try {
		const parsed: unknown = JSON.parse(data);
		const result = clientMessageSchema.safeParse(parsed);

		if (!result.success) {
			return {
				success: false,
				error: result.error.issues.map((issue) => issue.message).join(', '),
			};
		}

		return { success: true, data: result.data };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : 'Failed to parse message',
		};
	}
}
export function parseServerMessage(data: string): { success: true; data: ServerMessage } | { success: false; error: string } {
	try {
		const parsed: unknown = JSON.parse(data);
		const result = serverMessageSchema.safeParse(parsed);

		if (!result.success) {
			return {
				success: false,
				error: result.error.issues.map((issue) => issue.message).join(', '),
			};
		}

		return { success: true, data: result.data };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : 'Failed to parse message',
		};
	}
}
