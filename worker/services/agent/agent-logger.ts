import diagnosticsChannel from 'node:diagnostics_channel';

import { fs } from '@worker/lib/project-fs';

/**
 * Custom diagnostics channel for agent loop log events.
 * Published alongside the Agents SDK's built-in `agents:*` channels.
 * Auto-forwards to Tail Workers in production — zero overhead when nobody listens.
 */
const agentLogChannel = diagnosticsChannel.channel('agent-loop:log');
const MAX_DEBUG_LOGS = 20;
const MAX_FIELD_LENGTH = 500;
const LARGE_CONTENT_KEYS = new Set(['content', 'file_content', 'patch', 'diff', 'body', 'old_string', 'new_string', 'edits']);

export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

export type LogCategory = 'agent_loop' | 'llm' | 'tool_call' | 'tool_parse' | 'message' | 'snapshot' | 'context' | 'mcp' | 'session';

export interface AgentLogEntry {
	timestamp: string;
	elapsedMs: number;
	level: LogLevel;
	category: LogCategory;
	event: string;
	data?: Record<string, unknown>;
	iteration?: number;
	durationMs?: number;
}

export interface AgentDebugLogSummary {
	totalIterations: number;
	totalToolCalls: number;
	toolCallsByName: Record<string, number>;
	totalErrors: number;
	totalWarnings: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	doomLoopDetected: boolean;
	hitIterationLimit: boolean;
	aborted: boolean;
}

export interface AgentDebugLog {
	id: string;
	sessionId: string | undefined;
	projectId: string;
	model: string;
	mode: string;
	startedAt: string;
	completedAt: string;
	totalDurationMs: number;
	summary: AgentDebugLogSummary;
	entries: AgentLogEntry[];
}
function truncateString(value: string, maxLength: number = MAX_FIELD_LENGTH): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength)}... (${value.length} chars total)`;
}

/**
 * Sanitize tool input data for logging — truncate large content fields
 * to keep log files manageable while preserving enough context for debugging.
 */
export function sanitizeToolInput(input: Record<string, unknown>): Record<string, unknown> {
	const sanitized: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		if (LARGE_CONTENT_KEYS.has(key) && typeof value === 'string') {
			sanitized[key] = truncateString(value);
		} else if (typeof value === 'string' && value.length > MAX_FIELD_LENGTH * 2) {
			sanitized[key] = truncateString(value, MAX_FIELD_LENGTH * 2);
		} else {
			sanitized[key] = value;
		}
	}
	return sanitized;
}
export function summarizeToolResult(result: string): string {
	return truncateString(result);
}

/**
 * Truncate a string for full-content logging (system prompts, messages, LLM responses).
 * Uses a much higher limit than tool input sanitization.
 */

export class AgentLogger {
	readonly id: string;
	private readonly entries: AgentLogEntry[] = [];
	private readonly startTime: number;
	private currentIteration = 0;

	// Summary tracking (updated incrementally to avoid recomputing)
	private toolCallCount = 0;
	private readonly toolCallCounts = new Map<string, number>();
	private errorCount = 0;
	private warningCount = 0;
	private totalInputTokens = 0;
	private totalOutputTokens = 0;
	private doomLoopDetected = false;
	private hitIterationLimit = false;
	private aborted = false;
	private flushed = false;
	private entriesAtFlush = 0;

	constructor(
		private readonly sessionId: string | undefined,
		private readonly projectId: string,
		private readonly model: string,
		private readonly mode: string,
		persistedLog?: AgentDebugLog,
	) {
		this.startTime = persistedLog ? Date.parse(persistedLog.startedAt) : Date.now();
		const idPrefix = sessionId ?? crypto.randomUUID().slice(0, 8);
		this.id = persistedLog?.id ?? `${idPrefix}-${this.startTime}`;
		if (!persistedLog) return;
		this.entries.push(...persistedLog.entries);
		this.currentIteration = persistedLog.summary.totalIterations;
		this.toolCallCount = persistedLog.summary.totalToolCalls;
		for (const [name, count] of Object.entries(persistedLog.summary.toolCallsByName)) this.toolCallCounts.set(name, count);
		this.errorCount = persistedLog.summary.totalErrors;
		this.warningCount = persistedLog.summary.totalWarnings;
		this.totalInputTokens = persistedLog.summary.totalInputTokens;
		this.totalOutputTokens = persistedLog.summary.totalOutputTokens;
		this.doomLoopDetected = persistedLog.summary.doomLoopDetected;
		this.hitIterationLimit = persistedLog.summary.hitIterationLimit;
		this.aborted = persistedLog.summary.aborted;
	}

	// =========================================================================
	// Core Logging
	// =========================================================================
	log(level: LogLevel, category: LogCategory, event: string, data?: Record<string, unknown>, options?: { durationMs?: number }): void {
		const entry: AgentLogEntry = {
			timestamp: new Date().toISOString(),
			elapsedMs: Date.now() - this.startTime,
			level,
			category,
			event,
			...(data !== undefined && { data }),
			...(this.currentIteration > 0 && { iteration: this.currentIteration }),
			...(options?.durationMs !== undefined && { durationMs: options.durationMs }),
		};
		this.entries.push(entry);

		// Publish to diagnostics_channel for real-time observability.
		// Silent when nobody is listening (Tail Workers, subscribe(), etc.).
		if (agentLogChannel.hasSubscribers) {
			agentLogChannel.publish({
				sessionId: this.sessionId,
				projectId: this.projectId,
				model: this.model,
				mode: this.mode,
				...entry,
			});
		}

		// Allow re-flushing if new entries arrive after a previous flush.
		// Safe because flushes are always sequential (first in createAgentStream,
		// then in agent-runner's finally block after the stream completes).
		if (this.flushed && this.entries.length > this.entriesAtFlush) {
			this.flushed = false;
		}

		// Update summary counters
		if (level === 'error') this.errorCount++;
		if (level === 'warning') this.warningCount++;
	}
	debug(category: LogCategory, event: string, data?: Record<string, unknown>, options?: { durationMs?: number }): void {
		this.log('debug', category, event, data, options);
	}
	info(category: LogCategory, event: string, data?: Record<string, unknown>, options?: { durationMs?: number }): void {
		this.log('info', category, event, data, options);
	}
	warn(category: LogCategory, event: string, data?: Record<string, unknown>, options?: { durationMs?: number }): void {
		this.log('warning', category, event, data, options);
	}
	error(category: LogCategory, event: string, data?: Record<string, unknown>, options?: { durationMs?: number }): void {
		this.log('error', category, event, data, options);
	}

	// =========================================================================
	// Iteration Tracking
	// =========================================================================
	setIteration(iteration: number): void {
		this.currentIteration = iteration;
	}

	// =========================================================================
	// Summary Tracking
	// =========================================================================
	recordToolCall(toolName: string): void {
		this.toolCallCount++;
		this.toolCallCounts.set(toolName, (this.toolCallCounts.get(toolName) ?? 0) + 1);
	}
	recordTokenUsage(inputTokens: number, outputTokens: number): void {
		this.totalInputTokens += inputTokens;
		this.totalOutputTokens += outputTokens;
	}
	markDoomLoop(): void {
		this.doomLoopDetected = true;
	}
	markIterationLimit(): void {
		this.hitIterationLimit = true;
	}
	markAborted(): void {
		this.aborted = true;
	}

	// =========================================================================
	// Timer Helper
	// =========================================================================

	/**
	 * Start a timer. Returns a function that, when called, returns the elapsed
	 * milliseconds since the timer was started.
	 */
	startTimer(): () => number {
		const start = Date.now();
		return () => Date.now() - start;
	}

	// =========================================================================
	// Serialization
	// =========================================================================
	toJSON(): AgentDebugLog {
		const now = Date.now();
		const toolCallsByName: Record<string, number> = {};
		for (const [name, count] of this.toolCallCounts) {
			toolCallsByName[name] = count;
		}

		return {
			id: this.id,
			sessionId: this.sessionId,
			projectId: this.projectId,
			model: this.model,
			mode: this.mode,
			startedAt: new Date(this.startTime).toISOString(),
			completedAt: new Date(now).toISOString(),
			totalDurationMs: now - this.startTime,
			summary: {
				totalIterations: this.currentIteration,
				totalToolCalls: this.toolCallCount,
				toolCallsByName,
				totalErrors: this.errorCount,
				totalWarnings: this.warningCount,
				totalInputTokens: this.totalInputTokens,
				totalOutputTokens: this.totalOutputTokens,
				doomLoopDetected: this.doomLoopDetected,
				hitIterationLimit: this.hitIterationLimit,
				aborted: this.aborted,
			},
			entries: this.entries,
		};
	}

	// =========================================================================
	// Persistence
	// =========================================================================

	/**
	 * Whether the debug log has already been flushed to disk.
	 * Can be checked externally to avoid redundant work (e.g., in finally blocks).
	 */
	get isFlushed(): boolean {
		return this.flushed;
	}

	/**
	 * Flush the debug log to disk at `.agent/sessions/{sessionId}/debug-logs/{id}.json`.
	 * Also cleans up old logs beyond the retention limit.
	 *
	 * This is idempotent — calling it multiple times is safe. Only the first call
	 * writes to disk; subsequent calls are no-ops. This prevents double-flush issues
	 * when error handling paths overlap (e.g., catch block flushes and then the
	 * finally block tries again).
	 */
	async flush(projectRoot: string, logData = this.toJSON()): Promise<void> {
		if (this.flushed) return;
		this.flushed = true;

		const logsDirectory = this.sessionId
			? `${projectRoot}/.agent/sessions/${this.sessionId}/debug-logs`
			: `${projectRoot}/.agent/debug-logs`;

		try {
			await fs.mkdir(logsDirectory, { recursive: true });

			await fs.writeFile(`${logsDirectory}/${this.id}.json`, JSON.stringify(logData, undefined, 2));

			this.entriesAtFlush = this.entries.length;

			await this.cleanupOldLogs(logsDirectory);
		} catch (error) {
			// Non-fatal — don't let logging failures break the agent.
			// Reset the flag so a retry from the finally block can attempt again.
			this.flushed = false;
			console.error('Failed to flush agent debug log:', error);
		}
	}
	private async cleanupOldLogs(logsDirectory: string): Promise<void> {
		try {
			const entries = await fs.readdir(logsDirectory);
			const logFiles = entries
				.filter((entry) => entry.endsWith('.json'))
				.toSorted((a, b) => {
					// Log files are named {prefix}-{timestamp}.json — sort by the numeric timestamp suffix.
					const timestampA = Number(a.slice(0, -5).split('-').pop()) || 0;
					const timestampB = Number(b.slice(0, -5).split('-').pop()) || 0;
					return timestampA - timestampB;
				});

			// Remove the oldest log files beyond the retention limit.
			if (logFiles.length > MAX_DEBUG_LOGS) {
				const toRemove = logFiles.slice(0, logFiles.length - MAX_DEBUG_LOGS);
				for (const file of toRemove) {
					try {
						await fs.unlink(`${logsDirectory}/${file}`);
					} catch {
						// Non-fatal
					}
				}
			}
		} catch {
			// Non-fatal
		}
	}
}

export async function findLatestDebugLogId(projectRoot: string, sessionId: string): Promise<string | undefined> {
	try {
		const entries = await fs.readdir(`${projectRoot}/.agent/sessions/${sessionId}/debug-logs`);
		return entries
			.filter(
				(entry) => entry.startsWith(`${sessionId}-`) && entry.endsWith('.json') && /^\d+$/.test(entry.slice(sessionId.length + 1, -5)),
			)
			.toSorted((left, right) => Number(left.slice(sessionId.length + 1, -5)) - Number(right.slice(sessionId.length + 1, -5)))
			.at(-1)
			?.slice(0, -5);
	} catch {
		return undefined;
	}
}
