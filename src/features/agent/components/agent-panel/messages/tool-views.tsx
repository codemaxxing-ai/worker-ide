import { CheckCircle2, Circle, ListTodo, PlayCircle, Settings } from 'lucide-react';
import { useMemo } from 'react';

import { Pill, type PillProperties } from '@/components/ui/pill';
import { computeDiffHunks } from '@/features/editor/lib/diff-decorations';
import { cn } from '@/lib/utils';

import { isRecord } from '../helpers';
import { type TodoItemDisplay, stringifyConfigValue } from './tool-result-format';

function TodoStatusIcon({ status }: { status: TodoItemDisplay['status'] }) {
	switch (status) {
		case 'completed': {
			return <CheckCircle2 className="size-3.5 text-success" />;
		}
		case 'in_progress': {
			return <PlayCircle className="size-3.5 text-accent" />;
		}
		default: {
			return <Circle className="size-3.5 text-text-secondary" />;
		}
	}
}

const PRIORITY_PILL_COLOR: Record<TodoItemDisplay['priority'], NonNullable<PillProperties['color']>> = {
	high: 'error',
	medium: 'warning',
	low: 'muted',
};

export function InlineTodoList({ todos }: { todos: TodoItemDisplay[] }) {
	return (
		<div
			className="
				animate-chat-item rounded-lg border border-border bg-bg-secondary p-2
			"
		>
			<div
				className="
					mb-1.5 flex items-center gap-1.5 text-2xs font-semibold tracking-wider
					text-text-secondary uppercase
				"
			>
				<ListTodo className="size-3.5" />
				TODOs
			</div>
			<div className="flex flex-col gap-1">
				{todos.map((item) => (
					<div
						key={item.id}
						className="
							flex items-start gap-2 rounded-md bg-bg-primary px-2.5 py-1.5 text-xs
						"
					>
						<span className="mt-0.5 shrink-0">
							<TodoStatusIcon status={item.status} />
						</span>
						<span className={cn('flex-1 text-text-primary', item.status === 'completed' && 'text-text-secondary line-through')}>
							{item.content}
						</span>
						<Pill color={PRIORITY_PILL_COLOR[item.priority]} className="shrink-0">
							{item.priority}
						</Pill>
					</div>
				))}
			</div>
		</div>
	);
}

export function InlineKeyValueState({ title, entries }: { title: string; entries: Array<{ key: string; value: unknown }> }) {
	if (entries.length === 0) return;

	return (
		<div
			className="
				animate-chat-item rounded-lg border border-border bg-bg-secondary p-2
			"
		>
			<div
				className="
					mb-1.5 flex items-center gap-1.5 text-2xs font-semibold tracking-wider
					text-text-secondary uppercase
				"
			>
				<Settings className="size-3.5" />
				{title}
			</div>
			<div className="flex flex-col gap-1">
				{entries.map((entry) => (
					<div
						key={entry.key}
						className="
							flex items-center justify-between gap-3 rounded-md bg-bg-primary px-2.5
							py-1.5 text-xs
						"
					>
						<span className="text-text-secondary">{entry.key}</span>
						<span className="min-w-0 truncate font-mono text-text-primary">{stringifyConfigValue(entry.value)}</span>
					</div>
				))}
			</div>
		</div>
	);
}

/**
 * Render a compact unified diff view from before/after content.
 * Shows added lines in green, removed lines in red, with line numbers.
 */
export function InlineDiffView({ beforeContent, afterContent }: { beforeContent: string; afterContent: string }) {
	const hunks = useMemo(() => computeDiffHunks(beforeContent, afterContent), [beforeContent, afterContent]);

	if (hunks.length === 0) return;

	// Build rendered lines from hunks with a few lines of surrounding context.
	// We re-derive context from the afterContent so the diff is self-contained.
	const afterLines = afterContent.split('\n');

	// Build a set of "after" line numbers that are part of added hunks (1-indexed)
	const addedLineSet = new Set<number>();
	for (const hunk of hunks) {
		if (hunk.type === 'added') {
			for (let index = 0; index < hunk.lineCount; index++) {
				addedLineSet.add(hunk.startLine + index);
			}
		}
	}

	// Build diff display lines: show hunks with up to 2 lines of context
	const CONTEXT = 2;
	interface DiffLine {
		type: 'added' | 'removed' | 'context';
		content: string;
	}
	const diffLines: DiffLine[] = [];
	let lastRenderedAfterLine = 0;

	for (const hunk of hunks) {
		if (hunk.type === 'removed') {
			// Show context lines before this removed block
			const contextStart = Math.max(lastRenderedAfterLine + 1, hunk.startLine - CONTEXT);
			if (contextStart > lastRenderedAfterLine + 1 && diffLines.length > 0) {
				diffLines.push({ type: 'context', content: '···' });
			}
			for (let index = contextStart; index < hunk.startLine; index++) {
				if (!addedLineSet.has(index)) {
					diffLines.push({ type: 'context', content: afterLines[index - 1] ?? '' });
					lastRenderedAfterLine = index;
				}
			}
			// Render removed lines
			for (const line of hunk.lines) {
				diffLines.push({ type: 'removed', content: line });
			}
		} else {
			// Added hunk
			const contextStart = Math.max(lastRenderedAfterLine + 1, hunk.startLine - CONTEXT);
			if (contextStart > lastRenderedAfterLine + 1 && diffLines.length > 0) {
				diffLines.push({ type: 'context', content: '···' });
			}
			for (let index = contextStart; index < hunk.startLine; index++) {
				if (!addedLineSet.has(index)) {
					diffLines.push({ type: 'context', content: afterLines[index - 1] ?? '' });
					lastRenderedAfterLine = index;
				}
			}
			// Render added lines
			for (const line of hunk.lines) {
				diffLines.push({ type: 'added', content: line });
			}
			lastRenderedAfterLine = hunk.startLine + hunk.lineCount - 1;
		}
	}

	// Trailing context after last hunk
	const trailingStart = lastRenderedAfterLine + 1;
	const trailingEnd = Math.min(afterLines.length, lastRenderedAfterLine + CONTEXT);
	for (let index = trailingStart; index <= trailingEnd; index++) {
		if (!addedLineSet.has(index)) {
			diffLines.push({ type: 'context', content: afterLines[index - 1] ?? '' });
		}
	}

	return (
		<div
			className="
				max-h-60 overflow-auto rounded-md bg-bg-primary font-mono text-2xs/relaxed
			"
		>
			{diffLines.map((line, index) => (
				<div
					key={index}
					className={cn(
						'px-2.5 whitespace-pre-wrap',
						line.type === 'added' && 'bg-success/10 text-success',
						line.type === 'removed' && 'bg-error/10 text-error',
						line.type === 'context' && 'text-text-secondary',
					)}
				>
					<span className="mr-2 inline-block w-4 text-right opacity-50 select-none">
						{line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
					</span>
					{line.content || '\u00A0'}
				</div>
			))}
		</div>
	);
}
export function InlineDiagnosticsList({ diagnostics }: { diagnostics: unknown[] }) {
	return (
		<div
			className="
				max-h-40 overflow-auto rounded-md bg-bg-primary p-2 text-2xs/relaxed
			"
		>
			{diagnostics.map((diagnostic, index) => {
				if (!isRecord(diagnostic)) return;
				const line = typeof diagnostic.line === 'number' ? diagnostic.line : '?';
				const column = typeof diagnostic.column === 'number' ? diagnostic.column : '?';
				const severity = diagnostic.severity === 'error' ? 'error' : 'warning';
				const rule = typeof diagnostic.rule === 'string' ? diagnostic.rule : '';
				const message = typeof diagnostic.message === 'string' ? diagnostic.message : '';
				const fixable = diagnostic.fixable === true;

				return (
					<div key={index} className="flex items-start gap-2 py-0.5">
						<span className={cn('shrink-0 font-mono', severity === 'error' ? 'text-error' : 'text-warning')}>
							{line}:{column}
						</span>
						<span className="min-w-0 flex-1 text-text-secondary">
							{message}
							{rule && <span className="ml-1.5 text-text-secondary/60">({rule})</span>}
						</span>
						{fixable && (
							<Pill color="muted" size="xs" className="shrink-0">
								fixable
							</Pill>
						)}
					</div>
				);
			})}
		</div>
	);
}

/**
 * A labeled monospace block used in the codemode expanded view to show the
 * executed code and its output separately.
 */
export function InlineCodeSection({ label, content }: { label: string; content: string }) {
	if (!content) return;
	return (
		<div className="flex flex-col gap-1">
			<span
				className="
					text-2xs font-medium tracking-wide text-text-secondary/70 uppercase
				"
			>
				{label}
			</span>
			<pre
				className="
					max-h-60 overflow-auto rounded-md bg-bg-primary p-2.5 font-mono
					text-2xs/relaxed break-all whitespace-pre-wrap text-text-secondary
				"
			>
				{content}
			</pre>
		</div>
	);
}
