import { Bot, ChevronRight, Download, Wrench } from 'lucide-react';
import { useCallback } from 'react';

import { downloadDebugLog } from '@/lib/api-client';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';

import { isToolName } from '../helpers';
import { ToolIcon } from './tool-icon';

import type { SubAgentActivityRecord } from '@shared/agent-state';
import type { ToolName } from '@shared/validation';

export function InlineSubAgentActivity({
	toolCallId,
	subAgentActivities,
	metadata,
	rawResultContent,
	projectId,
	isExpanded,
}: {
	toolCallId: string;
	subAgentActivities?: Record<string, SubAgentActivityRecord>;
	metadata: Record<string, unknown> | undefined;
	rawResultContent: string | undefined;
	projectId: string | undefined;
	isExpanded: boolean;
}) {
	const sessionId = useStore((state) => state.sessionId);
	const activityRecord = subAgentActivities?.[toolCallId];
	const tools = activityRecord?.tools ?? [];
	const streamingText = activityRecord?.streamingText;
	const subAgentDebugLogId = activityRecord?.debugLogId ?? (typeof metadata?.debugLogId === 'string' ? metadata.debugLogId : undefined);

	// Use rawResultContent (final output) when available, otherwise show live streaming text
	const responseText = rawResultContent ?? streamingText;

	const handleDownloadLog = useCallback(() => {
		if (!subAgentDebugLogId || !projectId) return;
		void downloadDebugLog(projectId, subAgentDebugLogId, sessionId).catch(() => {});
	}, [subAgentDebugLogId, projectId, sessionId]);

	// When collapsed, only render if there's *active* streaming (no final result yet)
	if (!isExpanded && (!streamingText || rawResultContent) && tools.length === 0) return;

	return (
		<div className="flex flex-col gap-2 rounded-md bg-bg-primary p-2">
			{isExpanded && tools.length > 0 && (
				<div className="flex flex-col gap-0.5">
					<div
						className="
							mb-1 flex items-center gap-1.5 text-2xs font-semibold tracking-wider
							text-text-secondary uppercase
						"
					>
						<Bot className="size-3" />
						Sub-agent activity ({tools.length} tool call{tools.length === 1 ? '' : 's'})
					</div>
					{tools.map((entry, index) => {
						const entryToolName: ToolName | undefined = isToolName(entry.toolName) ? entry.toolName : undefined;
						const entryPath =
							typeof entry.metadata?.path === 'string'
								? entry.metadata.path
								: typeof entry.metadata?.file_path === 'string'
									? entry.metadata.file_path
									: undefined;
						return (
							<div
								key={index}
								className={cn(
									'flex items-center gap-2 rounded-sm px-2 py-0.5 text-2xs',
									entry.isError ? 'text-error' : 'text-text-secondary',
								)}
							>
								<span className="shrink-0">{entryToolName ? <ToolIcon name={entryToolName} /> : <Wrench className="size-3" />}</span>
								<span className="font-medium capitalize">{entry.toolName.replaceAll('_', ' ')}</span>
								{entryPath && <span className="max-w-32 truncate font-mono opacity-70">{entryPath}</span>}
								{entry.title && entry.title !== 'Error' && <span className="ml-auto shrink-0 text-text-secondary/70">{entry.title}</span>}
								{entry.isError && <span className="ml-auto shrink-0 text-error">Failed</span>}
							</div>
						);
					})}
				</div>
			)}
			{responseText && (
				<details className="group">
					<summary
						className="
							cursor-pointer text-2xs font-medium text-text-secondary transition-colors
							hover:text-text-primary
						"
					>
						<ChevronRight className="mr-1 inline size-3 transition-transform group-open:rotate-90" />
						{rawResultContent ? 'Sub-agent response' : 'Sub-agent output (streaming…)'}
					</summary>
					<pre
						className="
							mt-1.5 max-h-60 overflow-auto rounded-md bg-bg-secondary p-2 font-mono
							text-2xs/relaxed break-all whitespace-pre-wrap text-text-secondary
						"
					>
						{responseText}
					</pre>
				</details>
			)}
			{isExpanded && subAgentDebugLogId && projectId && (
				<button
					onClick={handleDownloadLog}
					className={cn(
						`
							inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-md px-2
							py-1
						`,
						'text-2xs font-medium text-text-secondary transition-colors',
						'hover:bg-bg-tertiary hover:text-text-primary',
					)}
				>
					<Download className="size-3" />
					Download sub-agent log
				</button>
			)}
		</div>
	);
}
