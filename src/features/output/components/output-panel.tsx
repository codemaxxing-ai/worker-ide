import { ScrollArea } from '@base-ui/react/scroll-area';
import { Ban, Circle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Pill } from '@/components/ui/pill';
import { Tooltip } from '@/components/ui/tooltip';
import { useFileTargetOpener } from '@/lib/file-target';
import { cn } from '@/lib/utils';

import { clearLogs, getPreserveLogs, setPreserveLogs, useLogs } from '../lib/log-buffer';

import type { LogEntry, OutputPanelProperties } from '../types';
import type { SourceLocation } from '@shared/types';

/**
 * Regex to match file references like `worker/database.ts:10:26` or
 * `at worker/database.ts:10:26` in log messages.
 */
const FILE_REFERENCE_PATTERN = /(?:at\s+)?(\S+\.(?:ts|tsx|js|jsx|mts|css|html))(?:\?[^\s:]*)?:(\d+)(?::(\d+))?/g;

/**
 * Normalize a captured file path to a project-relative path:
 * - Strip `virtual:` prefix from esbuild bundle error paths
 * - Extract `/src/...` from full preview-subdomain URLs
 * - Strip query strings left over from cache-busted URLs
 */
function normalizeFilePath(raw: string): string | undefined {
	let path = raw;

	// Strip esbuild virtual module prefix (e.g. "virtual:src/main.tsx" → "src/main.tsx")
	if (path.startsWith('virtual:')) {
		path = path.slice('virtual:'.length);
	}

	// Extract project-relative path from full preview URLs
	// e.g. "https://<project-id>-<token>.codemaxxing.net/src/main.tsx" → "/src/main.tsx"
	if (path.startsWith('http://') || path.startsWith('https://')) {
		try {
			const url = new URL(path);
			path = url.pathname;
		} catch {
			return undefined;
		}
	}

	// Strip leading query string remnants (shouldn't happen after URL parsing, but safety net)
	const queryIndex = path.indexOf('?');
	if (queryIndex !== -1) {
		path = path.slice(0, queryIndex);
	}

	return path;
}

type MessageSegment = { type: 'text'; value: string } | { type: 'file-link'; value: string; file: string; line: number; column?: number };

function normalizeSourceLocation(location: SourceLocation | undefined): SourceLocation | undefined {
	if (!location) return undefined;
	const normalizedFile = normalizeFilePath(location.file);
	if (!normalizedFile) return undefined;
	return {
		...location,
		file: normalizedFile,
	};
}

function formatSourceLocation(location: SourceLocation): string {
	return `${location.file}${location.line ? `:${location.line}` : ''}${location.column ? `:${location.column}` : ''}`;
}

function parseMessage(message: string): MessageSegment[] {
	const segments: MessageSegment[] = [];
	let lastIndex = 0;

	for (const match of message.matchAll(FILE_REFERENCE_PATTERN)) {
		const matchStart = match.index;
		// Add preceding text
		if (matchStart > lastIndex) {
			segments.push({ type: 'text', value: message.slice(lastIndex, matchStart) });
		}
		const normalizedFile = normalizeFilePath(match[1]);
		if (normalizedFile) {
			segments.push({
				type: 'file-link',
				value: match[0],
				file: normalizedFile,
				line: Number(match[2]),
				column: match[3] ? Number(match[3]) : undefined,
			});
		} else {
			segments.push({ type: 'text', value: match[0] });
		}
		lastIndex = matchStart + match[0].length;
	}

	// Add trailing text
	if (lastIndex < message.length) {
		segments.push({ type: 'text', value: message.slice(lastIndex) });
	}

	return segments.length > 0 ? segments : [{ type: 'text', value: message }];
}
export function OutputPanel({ className }: OutputPanelProperties) {
	const logs = useLogs();
	const [filter, setFilter] = useState<'all' | 'server' | 'client' | 'lint'>('all');
	const [preserve, setPreserve] = useState(getPreserveLogs);
	const scrollReference = useRef<HTMLDivElement>(null);
	const autoScrollReference = useRef(true);

	// Auto-scroll to bottom when new logs arrive
	useEffect(() => {
		if (autoScrollReference.current && scrollReference.current) {
			scrollReference.current.scrollTop = scrollReference.current.scrollHeight;
		}
	}, [logs]);

	const handleClear = useCallback(() => {
		clearLogs();
	}, []);

	const handleTogglePreserve = useCallback(() => {
		setPreserve((previous) => {
			const next = !previous;
			setPreserveLogs(next);
			return next;
		});
	}, []);

	// Filter logs
	const filteredLogs = logs.filter((log) => {
		if (filter === 'all') return true;
		return log.source === filter;
	});

	return (
		<div className={cn('flex h-full flex-col bg-bg-secondary', className)}>
			<div
				className="
					flex shrink-0 flex-wrap items-center justify-between gap-x-2 gap-y-0.5
					border-b border-border px-2 py-1
				"
			>
				<div role="radiogroup" aria-label="Log filter" className="flex items-center gap-0.5">
					<FilterButton active={filter === 'all'} onClick={() => setFilter('all')}>
						All
					</FilterButton>
					<FilterButton active={filter === 'server'} onClick={() => setFilter('server')}>
						Server
					</FilterButton>
					<FilterButton active={filter === 'client'} onClick={() => setFilter('client')}>
						Client
					</FilterButton>
					<FilterButton active={filter === 'lint'} onClick={() => setFilter('lint')}>
						Lint
					</FilterButton>
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					<Tooltip content={preserve ? 'Logs persist across rebuilds' : 'Logs clear on rebuild'}>
						<button
							type="button"
							aria-pressed={preserve}
							onClick={handleTogglePreserve}
							className={cn(
								`
									cursor-pointer rounded-sm px-1.5 py-px text-xs whitespace-nowrap
									transition-colors
								`,
								preserve ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:text-text-primary',
							)}
						>
							Preserve
						</button>
					</Tooltip>
					<Tooltip content="Clear logs">
						<button
							onClick={handleClear}
							className="
								flex size-5 cursor-pointer items-center justify-center rounded-sm
								text-text-secondary transition-colors
								hover:bg-bg-tertiary hover:text-text-primary
							"
							aria-label="Clear logs"
						>
							<Ban className="size-3" />
						</button>
					</Tooltip>
				</div>
			</div>

			<ScrollArea.Root className="flex-1 overflow-hidden">
				<ScrollArea.Viewport ref={scrollReference} className="size-full">
					{filteredLogs.length === 0 ? (
						<div
							className="
								flex h-full items-center justify-center py-2 text-xs text-text-secondary
							"
						>
							No logs yet
						</div>
					) : (
						<div className="px-3 py-2 font-mono text-xs">
							{filteredLogs.map((log) => (
								<LogLine key={log.id} log={log} />
							))}
						</div>
					)}
				</ScrollArea.Viewport>
				<ScrollArea.Scrollbar className="flex w-2 touch-none bg-transparent p-0.5 select-none" orientation="vertical">
					<ScrollArea.Thumb className="relative flex-1 rounded-full bg-border" />
				</ScrollArea.Scrollbar>
			</ScrollArea.Root>
		</div>
	);
}

function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
	return (
		<button
			type="button"
			role="radio"
			aria-checked={active}
			onClick={onClick}
			className={cn(
				'cursor-pointer rounded-sm px-1.5 py-px text-xs transition-colors',
				active ? 'bg-bg-tertiary text-text-primary' : 'text-text-secondary hover:text-text-primary',
			)}
		>
			{children}
		</button>
	);
}

const LEVEL_COLORS: Record<LogEntry['level'], string> = {
	log: 'text-text-secondary',
	info: 'text-blue-600 dark:text-blue-400',
	warning: 'text-yellow-600 dark:text-yellow-400',
	error: 'text-red-600 dark:text-red-400',
	debug: 'text-gray-500',
};

const SOURCE_PILL_COLOR: Record<string, 'purple' | 'cyan' | 'yellow'> = {
	server: 'purple',
	client: 'cyan',
	lint: 'yellow',
};

function LogLine({ log }: { log: LogEntry }) {
	const time = new Date(log.timestamp).toLocaleTimeString('en-US', {
		hour12: false,
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	});

	const location = normalizeSourceLocation(log.location);
	const segments: MessageSegment[] = location ? [{ type: 'text', value: log.message }] : parseMessage(log.message);

	return (
		<div
			className="
				flex items-start gap-2 rounded-sm p-1
				hover:bg-bg-tertiary/50
			"
		>
			<span className="shrink-0 text-text-secondary">{time}</span>
			{log.source && log.source !== 'system' && (
				<Pill size="xs" rounded="sm" color={SOURCE_PILL_COLOR[log.source]} className="mt-px shrink-0 uppercase">
					{log.source === 'server' ? 'worker' : log.source === 'lint' ? 'lint' : 'client'}
				</Pill>
			)}
			<Circle className={cn('mt-1 size-2 shrink-0', LEVEL_COLORS[log.level])} fill="currentColor" />
			<span className="break-all whitespace-pre-wrap text-text-primary">
				{segments.map((segment, index) =>
					segment.type === 'file-link' ? (
						<FileLink key={index} file={segment.file} line={segment.line} column={segment.column}>
							{segment.value}
						</FileLink>
					) : (
						<span key={index}>{segment.value}</span>
					),
				)}
				{location && (
					<span>
						{'\n  at '}
						<FileLink file={location.file} line={location.line} column={location.column}>
							{formatSourceLocation(location)}
						</FileLink>
					</span>
				)}
			</span>
		</div>
	);
}

function FileLink({ file, line, column, children }: { file: string; line?: number; column?: number; children: React.ReactNode }) {
	const openFileTarget = useFileTargetOpener();

	const handleClick = useCallback(() => {
		if (line === undefined) {
			openFileTarget({ path: file });
			return;
		}
		openFileTarget({ path: file, position: { line, column: column ?? 1 } });
	}, [column, file, line, openFileTarget]);

	return (
		<button
			type="button"
			onClick={handleClick}
			className="
				cursor-pointer text-accent underline decoration-accent/40 transition-colors
				hover:text-accent-hover hover:decoration-accent-hover
			"
		>
			{children}
		</button>
	);
}
