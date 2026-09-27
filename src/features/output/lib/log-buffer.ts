import { createStore, useStore } from 'zustand';

import { onEditorEvent } from '@/lib/editor-events';
import { isMessageFromPreview } from '@/lib/preview-origin';

import type { LogEntry } from '../types';
import type { ServerError, SourceLocation } from '@shared/types';

interface LogBufferState {
	entries: LogEntry[];
	preserveLogs: boolean;
}

let idCounter = 0;
const seenErrorIds = new Set<string>();

function nextId(): string {
	idCounter++;
	return `log-${idCounter}`;
}

const logBufferStore = createStore<LogBufferState>(() => ({
	entries: [],
	preserveLogs: false,
}));

function append(...newEntries: LogEntry[]) {
	logBufferStore.setState((state) => ({
		entries: [...state.entries, ...newEntries],
	}));
}

function isSourceLocation(value: unknown): value is SourceLocation {
	if (typeof value !== 'object' || value === undefined || value === null) return false;
	if (!('file' in value) || typeof value.file !== 'string' || value.file.trim() === '') return false;
	if ('line' in value && value.line !== undefined && typeof value.line !== 'number') return false;
	if ('column' in value && value.column !== undefined && typeof value.column !== 'number') return false;
	return true;
}

function resolveLogLevel(level: unknown): LogEntry['level'] {
	if (level === 'warn' || level === 'warning') return 'warning';
	if (level === 'error') return 'error';
	if (level === 'debug') return 'debug';
	if (level === 'info') return 'info';
	return 'log';
}

function appendServerError(error: ServerError, source: LogEntry['source']) {
	if (error.id && seenErrorIds.has(error.id)) return;
	if (error.id) seenErrorIds.add(error.id);
	append({
		id: nextId(),
		timestamp: error.timestamp,
		level: 'error',
		message: error.message,
		source,
		location: error.location,
	});
}

function formatSourceLocation(location: SourceLocation): string {
	return `${location.file}${location.line ? `:${location.line}` : ''}${location.column ? `:${location.column}` : ''}`;
}

function clearIfNotPreserving() {
	const { preserveLogs } = logBufferStore.getState();
	if (!preserveLogs) {
		seenErrorIds.clear();
		logBufferStore.setState({ entries: [] });
	}
}

onEditorEvent('server-error', (error) => {
	appendServerError(error, 'server');
});

onEditorEvent('rebuild', () => {
	clearIfNotPreserving();
});

onEditorEvent('server-logs', (logs) => {
	append(
		...logs.map((log) => ({
			id: nextId(),
			timestamp: log.timestamp,
			level: log.level,
			message: log.message,
			source: 'server' as const,
			location: log.location,
		})),
	);
});
onEditorEvent('preview-refresh', () => {
	clearIfNotPreserving();
});

/**
 * Listen for lint-diagnostics events dispatched by the Biome lint extension.
 * Replaces previous lint entries for the same file with the new diagnostics.
 */
interface LintDiagnosticEvent {
	filePath: string;
	diagnostics: Array<{
		message: string;
		severity: string;
		line: number;
		column: number;
		rule?: string;
	}>;
}

function isLintDiagnosticEvent(value: unknown): value is LintDiagnosticEvent {
	if (typeof value !== 'object' || value === undefined || value === null) return false;
	if (!('filePath' in value) || !('diagnostics' in value)) return false;
	const { filePath, diagnostics } = value;
	return typeof filePath === 'string' && Array.isArray(diagnostics);
}

globalThis.addEventListener('lint-diagnostics', (event: Event) => {
	if (!(event instanceof CustomEvent)) return;
	if (!isLintDiagnosticEvent(event.detail)) return;

	const { filePath, diagnostics } = event.detail;

	// Remove previous lint entries for this file
	logBufferStore.setState((state) => ({
		entries: state.entries.filter((entry) => !(entry.source === 'lint' && entry.message.includes(filePath))),
	}));

	if (diagnostics.length === 0) return;

	const newEntries: LogEntry[] = diagnostics.map((diagnostic) => ({
		id: nextId(),
		timestamp: Date.now(),
		level: diagnostic.severity === 'error' ? ('error' as const) : ('warning' as const),
		message: `${diagnostic.rule ? `(${diagnostic.rule}) ` : ''}${diagnostic.message}`,
		source: 'lint' as const,
		location: { file: filePath, line: diagnostic.line, column: diagnostic.column },
	}));

	append(...newEntries);
});

/**
 * Listen for postMessage events from the preview iframe:
 * - __console-log: forwarded by chobitsu CDP Runtime.consoleAPICalled events
 * - __server-error: forwarded by the preview HMR client when it receives a server error
 *
 * The preview runs on a separate subdomain, so we validate the origin.
 */
globalThis.addEventListener('message', (event: MessageEvent) => {
	if (!isMessageFromPreview(event)) return;

	const { type } = event.data ?? {};

	if (type === '__console-log') {
		const { level, location, message, timestamp } = event.data;
		if (typeof message !== 'string' || typeof timestamp !== 'number') return;

		append({
			id: nextId(),
			timestamp,
			level: resolveLogLevel(level),
			message,
			source: 'client',
			location: isSourceLocation(location) ? location : undefined,
		});
		return;
	}

	if (type === '__server-error') {
		const error = event.data.error;
		if (!error || typeof error.message !== 'string') return;
		appendServerError(
			{
				id: typeof error.id === 'string' ? error.id : '',
				timestamp: typeof error.timestamp === 'number' ? error.timestamp : Date.now(),
				type: error.type === 'runtime' ? 'runtime' : 'bundle',
				message: error.message,
				location: isSourceLocation(error.location) ? error.location : undefined,
				dependencyErrors: Array.isArray(error.dependencyErrors) ? error.dependencyErrors : undefined,
			},
			'client',
		);
	}
});
export function useLogs(): LogEntry[] {
	return useStore(logBufferStore, (state) => state.entries);
}

export function clearLogs(): void {
	seenErrorIds.clear();
	logBufferStore.setState({ entries: [] });
}

/**
 * The project whose logs currently fill the (process-global) buffer.
 *
 * The log buffer and its event listeners live at module scope for the tab's
 * lifetime. Switching projects is SPA navigation that never reloads this module,
 * so without an explicit reset the previous project's console/server logs would
 * leak into the new project's output panel. {@link setActiveLogProject} clears
 * the buffer whenever the active project changes.
 */
let activeProjectId: string | undefined;

/** Reset the log buffer when the active project changes (idempotent for the same id). */
export function setActiveLogProject(projectId: string): void {
	if (activeProjectId === projectId) return;
	activeProjectId = projectId;
	seenErrorIds.clear();
	logBufferStore.setState({ entries: [] });
}

export function getPreserveLogs(): boolean {
	return logBufferStore.getState().preserveLogs;
}

export function setPreserveLogs(value: boolean): void {
	logBufferStore.setState({ preserveLogs: value });
}

/**
 * Debounced sync of output logs to the coordinator via the project WebSocket.
 * Only sends when entries actually change, with a 1s debounce to avoid flooding.
 */
let syncTimeout: ReturnType<typeof setTimeout> | undefined;
const SYNC_DEBOUNCE_MS = 1000;

function scheduleSyncToCoordinator() {
	if (syncTimeout !== undefined) clearTimeout(syncTimeout);
	syncTimeout = setTimeout(() => {
		syncTimeout = undefined;
		// Dynamic import to avoid circular dependency — projectSocketSendReference
		// is a simple { current } ref object, not a React hook.
		void import('@/features/collaboration/hooks/use-project-socket').then(({ projectSocketSendReference }) => {
			const send = projectSocketSendReference.current;
			if (!send) return;
			const snapshot = getLogSnapshot();
			send({ type: 'output-logs-sync', logs: snapshot });
		});
	}, SYNC_DEBOUNCE_MS);
}

// Subscribe to store changes and sync on every mutation
logBufferStore.subscribe(() => {
	scheduleSyncToCoordinator();
});

/**
 * Return a formatted snapshot of recent log entries for AI agent context.
 * Caps output at `maxEntries` entries and `maxBytes` total characters.
 */
const LOG_SNAPSHOT_MAX_ENTRIES = 50;
const LOG_SNAPSHOT_MAX_BYTES = 8192;

export function getLogSnapshot(maxEntries = LOG_SNAPSHOT_MAX_ENTRIES, maxBytes = LOG_SNAPSHOT_MAX_BYTES): string {
	const { entries } = logBufferStore.getState();
	if (entries.length === 0) return '';

	const recent = entries.slice(-maxEntries);
	const lines: string[] = [];
	let totalLength = 0;

	for (const entry of recent) {
		const time = new Date(entry.timestamp).toLocaleTimeString('en-US', {
			hour12: false,
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		});
		const source = entry.source ? `[${entry.source}]` : '';
		const location = entry.location ? `\n  at ${formatSourceLocation(entry.location)}` : '';
		const line = `${time} ${source} ${entry.level.toUpperCase()}: ${entry.message}${location}`;

		if (totalLength + line.length > maxBytes) break;
		lines.push(line);
		totalLength += line.length;
	}

	return lines.join('\n');
}
