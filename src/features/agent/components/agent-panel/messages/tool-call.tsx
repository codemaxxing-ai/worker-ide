import { ChevronRight, Wrench } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { Spinner } from '@/components/ui/spinner';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import { FileReference } from '../../file-reference';
import { isToolName } from '../helpers';
import { InlineSubAgentActivity } from './sub-agent-activity';
import { ToolIcon } from './tool-icon';
import {
	getToolResultContent,
	isToolError,
	isTodoItemDisplay,
	parseTodosFromRawResult,
	getAssetSettingsEntries,
	getBindingsEntries,
	shortenErrorFromStructured,
	summarizeFromMetadata,
	deriveCompletedLabel,
	getExpandableDetailText,
} from './tool-result-format';
import { InlineCodeSection, InlineDiffView, InlineDiagnosticsList, InlineTodoList, InlineKeyValueState } from './tool-views';

import type { SubAgentActivityRecord } from '@shared/agent-state';
import type { ToolCallPart, ToolErrorInfo, ToolMetadataInfo, ToolResultPart } from '@shared/types';
import type { ToolName } from '@shared/validation';

const CONTENT_STREAMING_TOOLS = new Set<string>(['codemode', 'bash']);

export function InlineToolCall({
	toolCall,
	toolResult,
	toolErrors,
	toolMetadata,
	fileDiffContent,
	subAgentActivities,
	projectId,
	isStreaming,
	isExpanded,
	onToggleExpand,
}: {
	toolCall: ToolCallPart;
	toolResult?: ToolResultPart;
	toolErrors?: Map<string, ToolErrorInfo>;
	toolMetadata?: Map<string, ToolMetadataInfo>;
	fileDiffContent?: Map<string, { beforeContent: string; afterContent: string }>;
	subAgentActivities?: Record<string, SubAgentActivityRecord>;
	projectId?: string;
	isStreaming?: boolean;
	isExpanded: boolean;
	onToggleExpand: () => void;
}) {
	const knownToolName: ToolName | undefined = isToolName(toolCall.toolName) ? toolCall.toolName : undefined;
	const displayToolName = toolCall.toolName || 'unknown';

	// Derive execution state from whether a result exists
	const isCompleted = toolResult !== undefined;
	const isExecuting = !toolResult && !!isStreaming;
	const isCancelled = !toolResult && !isStreaming;
	const rawResultContent = getToolResultContent(toolResult);
	const isUnknownTool = knownToolName === undefined;

	// Whether tool arguments are still being streamed (empty arguments = still receiving deltas)
	const isArgumentsStreaming = isStreaming && !isCompleted && Object.keys(toolCall.arguments).length === 0;

	// Structured metadata from tool_result events (populated during streaming)
	const structuredMetadata = toolMetadata?.get(toolCall.toolCallId);
	const metadata = structuredMetadata?.metadata;

	// Structured error data from tool_error events.
	// Unknown (unsupported/hallucinated) tools are NOT treated as execution
	// errors — they render with neutral styling instead of the alarming red path.
	const structuredError = toolErrors?.get(toolCall.toolCallId);
	const isError = structuredError !== undefined || isToolError(toolResult);

	// Extract file paths from tool arguments.
	// Accept `file_path` (schema-defined), `path` (legacy/search tools), and `filePath` (model sometimes hallucinates this key).
	const input = toolCall.arguments;
	const singlePath =
		typeof input.file_path === 'string'
			? input.file_path
			: typeof input.path === 'string'
				? input.path
				: typeof input.filePath === 'string'
					? input.filePath
					: undefined;
	let fromPath: string | undefined;
	let toPath: string | undefined;
	let pattern: string | undefined;
	let extraLabel: string | undefined;
	if (!singlePath && typeof input.from_path === 'string' && typeof input.to_path === 'string') {
		fromPath = input.from_path;
		toPath = input.to_path;
	}
	if (typeof input.pattern === 'string') {
		pattern = input.pattern;
	}
	if (typeof input.url === 'string') {
		extraLabel = input.url;
	}
	if (typeof input.query === 'string') {
		extraLabel = input.query;
	}
	if (typeof input.prompt === 'string') {
		extraLabel = input.prompt;
	}

	// Streaming content preview for code/command tools (codemode, bash)
	const streamingContent =
		isArgumentsStreaming && CONTENT_STREAMING_TOOLS.has(toolCall.toolName)
			? typeof input.code === 'string'
				? input.code
				: typeof input.command === 'string'
					? input.command
					: undefined
			: undefined;

	// Executed code for codemode — shown in the expanded detail so the code
	// stays visible after streaming completes (streamingContent clears on done).
	const codemodeCode = knownToolName === 'codemode' && typeof input.code === 'string' ? input.code : undefined;

	// Auto-scroll ref for the streaming content preview
	const streamingPreviewReference = useRef<HTMLPreElement>(null);
	useEffect(() => {
		if (streamingContent && streamingPreviewReference.current) {
			streamingPreviewReference.current.scrollTop = streamingPreviewReference.current.scrollHeight;
		}
	}, [streamingContent]);

	// Extract TODOs — prefer structured metadata, fall back to parsing raw result
	const metadataTodos = metadata && Array.isArray(metadata.todos) ? metadata.todos.filter((item) => isTodoItemDisplay(item)) : undefined;
	const todos = metadataTodos ?? parseTodosFromRawResult(rawResultContent);
	const assetSettingsEntries =
		knownToolName === 'asset_settings_get' || knownToolName === 'asset_settings_update' ? getAssetSettingsEntries(metadata) : undefined;
	const bindingsEntries =
		knownToolName === 'bindings_get' || knownToolName === 'bindings_update' ? getBindingsEntries(metadata) : undefined;
	const planFilePath = knownToolName === 'plan_update' && typeof metadata?.planFilePath === 'string' ? metadata.planFilePath : undefined;

	// Extract file-edit stats from structured metadata (lint_fix).
	// Metadata is always available — persisted with the session for loaded sessions.
	const linesAdded = typeof metadata?.linesAdded === 'number' ? metadata.linesAdded : undefined;
	const linesRemoved = typeof metadata?.linesRemoved === 'number' ? metadata.linesRemoved : undefined;
	const lintErrorCount =
		typeof metadata?.diagnostics === 'object' && Array.isArray(metadata.diagnostics) ? metadata.diagnostics.length : undefined;
	const hasEditStats = linesAdded !== undefined && (linesAdded > 0 || (linesRemoved ?? 0) > 0 || (lintErrorCount ?? 0) > 0);

	// Build summary text from structured metadata (single code path for both
	// live-streamed and loaded sessions — no raw-text fallbacks).
	const resultSummary = isUnknownTool
		? `Unsupported tool: ${displayToolName}`
		: isError
			? structuredError
				? shortenErrorFromStructured(structuredError)
				: 'Failed'
			: hasEditStats
				? undefined
				: structuredMetadata
					? summarizeFromMetadata(knownToolName, structuredMetadata)
					: isCompleted
						? deriveCompletedLabel(knownToolName, rawResultContent)
						: isCancelled
							? 'Cancelled'
							: isExecuting
								? 'Running...'
								: undefined;

	// Diagnostics from metadata for expanded view
	const diagnostics = metadata && Array.isArray(metadata.diagnostics) ? metadata.diagnostics : undefined;

	// Diff content from the file_changed CUSTOM event (carries beforeContent/afterContent)
	const diffContent = fileDiffContent?.get(toolCall.toolCallId);
	const hasDiffContent = diffContent !== undefined;

	// Every completed tool call with content or a structured error is expandable.
	// File-editing tools with before/after content are also expandable (for the diff view).
	const hasDetailContent = rawResultContent !== undefined || structuredError !== undefined || hasDiffContent || codemodeCode !== undefined;
	// Once the user has opened a pill, keep it expandable so subsequent state
	// updates (streaming → completed, metadata arriving, etc.) never collapse it.
	const expandable = isExpanded || (!isUnknownTool && (isCompleted || codemodeCode !== undefined) && hasDetailContent);

	return (
		<div className="flex min-w-0 animate-chat-item flex-col gap-1.5">
			<div
				onClick={() => expandable && onToggleExpand()}
				onKeyDown={
					expandable
						? (event) => {
								if (event.key === 'Enter' || event.key === ' ') {
									event.preventDefault();
									onToggleExpand();
								}
							}
						: undefined
				}
				role={expandable ? 'button' : undefined}
				tabIndex={expandable ? 0 : undefined}
				className={cn(
					`
						flex flex-wrap items-center gap-x-2 gap-y-1 overflow-hidden rounded-md
						px-3 py-1.5 text-xs
					`,
					isUnknownTool && 'bg-bg-tertiary text-text-secondary',
					!isUnknownTool && isCompleted && !isError && 'bg-success/5 text-text-secondary',
					!isUnknownTool && isError && 'bg-error/5 text-error',
					!isUnknownTool && !isCompleted && !isError && 'bg-bg-tertiary text-text-secondary',
					expandable &&
						`
							cursor-pointer transition-colors
							hover:bg-bg-tertiary
						`,
				)}
			>
				{expandable ? (
					<ChevronRight className={cn('size-3 shrink-0 transition-transform', isExpanded && 'rotate-90')} />
				) : !isCompleted && !isError && !isCancelled ? (
					<Spinner className="size-3 shrink-0 text-accent" />
				) : undefined}
				<span
					className={cn(
						'shrink-0',
						isUnknownTool ? 'text-text-secondary' : isCompleted && !isError ? 'text-success' : isError ? 'text-error' : undefined,
					)}
				>
					{knownToolName ? <ToolIcon name={knownToolName} /> : <Wrench className="size-3" />}
				</span>
				<span className="shrink-0 font-medium capitalize">{displayToolName.replaceAll('_', ' ')}</span>
				{singlePath && (
					<FileReference
						path={singlePath}
						className="max-w-48 truncate"
						interactive={false}
						onClick={(event) => {
							event.stopPropagation();
						}}
					/>
				)}
				{fromPath && toPath && (
					<span className="flex max-w-48 items-center gap-1">
						<FileReference
							path={fromPath}
							className="truncate"
							interactive={false}
							onClick={(event) => {
								event.stopPropagation();
							}}
						/>
						<span className="shrink-0 text-text-secondary">→</span>
						<FileReference
							path={toPath}
							className="truncate"
							interactive={false}
							onClick={(event) => {
								event.stopPropagation();
							}}
						/>
					</span>
				)}
				{pattern && (
					<Tooltip content={pattern} side="bottom">
						<span className="max-w-48 truncate font-mono text-text-secondary">{pattern}</span>
					</Tooltip>
				)}
				{!singlePath && !fromPath && !pattern && extraLabel && (
					<Tooltip content={extraLabel} side="bottom">
						<span className="max-w-48 truncate text-text-secondary">
							{knownToolName === 'sub_agent' && typeof metadata?.shortTitle === 'string'
								? metadata.shortTitle
								: extraLabel.length > 60
									? extraLabel.slice(0, 60) + '...'
									: extraLabel}
						</span>
					</Tooltip>
				)}
				{planFilePath && (
					<FileReference
						path={planFilePath}
						className="max-w-48 truncate"
						interactive={false}
						onClick={(event) => {
							event.stopPropagation();
						}}
					/>
				)}
				{resultSummary && <span className="ml-auto min-w-0 truncate text-text-secondary">{resultSummary}</span>}
				{hasEditStats && (
					<span className={cn('flex shrink-0 items-center gap-1.5', !resultSummary && 'ml-auto')}>
						{linesAdded !== undefined && linesAdded > 0 && (
							<span className="font-mono text-success" title={`${linesAdded} line${linesAdded === 1 ? '' : 's'} added`}>
								+{linesAdded}
							</span>
						)}
						{linesRemoved !== undefined && linesRemoved > 0 && (
							<span className="font-mono text-error" title={`${linesRemoved} line${linesRemoved === 1 ? '' : 's'} removed`}>
								-{linesRemoved}
							</span>
						)}
						{lintErrorCount !== undefined && lintErrorCount > 0 && (
							<span className="font-mono text-warning" title={`${lintErrorCount} lint error${lintErrorCount === 1 ? '' : 's'}`}>
								⚠ {lintErrorCount}
							</span>
						)}
					</span>
				)}
			</div>
			{streamingContent && (
				<pre
					ref={streamingPreviewReference}
					className="
						max-h-40 overflow-auto rounded-md border border-accent/20 bg-bg-primary
						p-2.5 font-mono text-2xs/relaxed break-all whitespace-pre-wrap
						text-text-secondary
					"
				>
					{streamingContent}
				</pre>
			)}
			{isExpanded && codemodeCode !== undefined && (
				<div className="flex flex-col gap-1.5">
					<InlineCodeSection label="Code" content={codemodeCode} />
					{rawResultContent !== undefined && (
						<InlineCodeSection label="Output" content={getExpandableDetailText('codemode', rawResultContent, structuredError)} />
					)}
				</div>
			)}
			{isExpanded &&
				hasDetailContent &&
				codemodeCode === undefined &&
				knownToolName !== 'sub_agent' &&
				(hasDiffContent ? (
					<InlineDiffView beforeContent={diffContent.beforeContent} afterContent={diffContent.afterContent} />
				) : (
					<pre
						className="
							max-h-60 overflow-auto rounded-md bg-bg-primary p-2.5 font-mono
							text-2xs/relaxed break-all whitespace-pre-wrap text-text-secondary
						"
					>
						{knownToolName ? getExpandableDetailText(knownToolName, rawResultContent, structuredError) : rawResultContent}
					</pre>
				))}
			{isExpanded && diagnostics && diagnostics.length > 0 && <InlineDiagnosticsList diagnostics={diagnostics} />}
			{knownToolName === 'sub_agent' && (
				<InlineSubAgentActivity
					toolCallId={toolCall.toolCallId}
					subAgentActivities={subAgentActivities}
					metadata={metadata}
					rawResultContent={rawResultContent}
					projectId={projectId}
					isExpanded={isExpanded}
				/>
			)}
			{todos && todos.length > 0 && <InlineTodoList todos={todos} />}
			{assetSettingsEntries && <InlineKeyValueState title="Asset settings" entries={assetSettingsEntries} />}
			{bindingsEntries && <InlineKeyValueState title="Bindings" entries={bindingsEntries} />}
		</div>
	);
}
