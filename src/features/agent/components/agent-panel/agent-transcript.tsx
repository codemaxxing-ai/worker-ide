import { getToolName, isToolUIPart } from 'ai';
import { memo, useId, useState } from 'react';
import { z } from 'zod';

import { cn } from '@/lib/utils';
import { agentToolProgressSchema, initialChatState } from '@shared/agent-chat';

import { MarkdownContent } from '../markdown-content';
import { CommandOutput } from './messages/command-output';
import { InlineToolCall } from './messages/tool-call';

import type { AgentMessage, ChatState } from '@shared/agent-chat';
import type { ToolMetadataInfo } from '@shared/types';
import type { AgentToolRunState } from 'agents/agent-tools';
import type { UIMessage } from 'ai';

const NativeToolCard = memo(function NativeToolCard({
	part,
	state,
	projectId,
	runs,
	submissionId,
}: {
	part: Extract<UIMessage['parts'][number], { type: 'dynamic-tool' | `tool-${string}` }>;
	state?: ChatState;
	projectId: string;
	runs?: AgentToolRunState<UIMessage['parts'][number]>[];
	submissionId?: string;
}) {
	const [expanded, setExpanded] = useState(false);
	const instanceId = useId();
	const toolName = getToolName(part);
	const input = z.record(z.string(), z.unknown()).safeParse(part.input);
	const completed = part.state === 'output-available' || part.state === 'output-error';
	const output = part.state === 'output-available' ? part.output : undefined;
	const structured = z.object({ title: z.string(), metadata: z.record(z.string(), z.unknown()) }).safeParse(output);
	const expectedRunId =
		structured.success && typeof structured.data.metadata.runId === 'string'
			? structured.data.metadata.runId
			: submissionId
				? `agent-tool:${submissionId}:${part.toolCallId}`
				: undefined;
	const scopedRuns = runs?.filter((run) => (expectedRunId ? run.runId === expectedRunId : runs.length === 1));
	const metadata = new Map<string, ToolMetadataInfo>(Object.entries(state?.toolMetadata ?? {}));
	if (structured.success)
		metadata.set(part.toolCallId, {
			toolCallId: part.toolCallId,
			toolName,
			...structured.data,
			commandOutput: metadata.get(part.toolCallId)?.commandOutput,
		});
	else {
		const value = z.record(z.string(), z.unknown()).safeParse(output);
		if (value.success)
			metadata.set(part.toolCallId, {
				toolCallId: part.toolCallId,
				toolName,
				title: typeof value.data.path === 'string' ? value.data.path : toolName,
				metadata: value.data,
			});
	}
	return (
		<div>
			<InlineToolCall
				instanceId={instanceId}
				toolCall={{ type: 'tool-call', toolCallId: part.toolCallId, toolName, arguments: input.success ? input.data : {} }}
				toolResult={
					completed
						? {
								type: 'tool-result',
								toolCallId: part.toolCallId,
								toolName,
								result:
									part.state === 'output-error' ? part.errorText : typeof output === 'string' ? output : (JSON.stringify(output) ?? ''),
								isError: part.state === 'output-error',
							}
						: undefined
				}
				toolMetadata={metadata}
				toolErrors={new Map(Object.entries(state?.toolErrors ?? {}))}
				isStreaming={!completed && state?.status === 'running'}
				isExpanded={expanded}
				onToggleExpand={() => setExpanded((value) => !value)}
			/>
			{expanded &&
				scopedRuns?.map((run) => (
					<details key={run.runId} className="ml-3 border-l border-border pl-3 text-xs">
						<summary id={`agent-task-${run.runId}`} className="cursor-pointer py-1 focus-visible:outline-accent">
							{run.display?.name ?? 'Delegated task'} · {run.status}
						</summary>
						<AgentTranscript
							messages={[{ id: run.runId, role: 'assistant', parts: run.parts }]}
							projectId={projectId}
							state={run.status === 'running' ? { ...initialChatState(), status: 'running' } : undefined}
						/>
						{agentToolProgressSchema.safeParse(run.progress?.data).success && <TaskCommandOutput data={run.progress?.data} />}
						{run.error && <p className="text-error">{run.error}</p>}
					</details>
				))}
		</div>
	);
});

export function AgentTranscript({
	messages,
	state,
	projectId,
	runsByToolCallId = {},
	onRestore,
	onBranch,
	onVersions,
}: {
	messages: AgentMessage[];
	state?: ChatState;
	projectId: string;
	runsByToolCallId?: Record<string, AgentToolRunState<UIMessage['parts'][number]>[]>;
	onRestore?: (message: AgentMessage) => void;
	onBranch?: (message: AgentMessage) => void;
	onVersions?: (message: AgentMessage) => void;
}) {
	const transcriptId = useId();
	return (
		<div className="flex flex-col gap-5" data-testid="agent-transcript">
			{messages.map((message) => (
				<article
					key={message.id}
					data-message-id={message.id}
					className={cn('min-w-0', message.role === 'user' && 'rounded-xl border border-accent/15 bg-accent/5 p-3')}
				>
					<div
						className="
							mb-2 flex items-center justify-between gap-2 text-[10px] font-semibold
							tracking-wider text-text-secondary uppercase
						"
					>
						<span>{message.role === 'user' ? (message.metadata?.authorName ?? 'User') : 'Assistant'}</span>
						{state?.status !== 'running' && !state?.finalizing && (
							<div className="flex gap-2 normal-case">
								{onVersions && message.role === 'user' && (
									<button
										id={`agent-versions-${transcriptId}-${message.id}`}
										onClick={() => onVersions(message)}
										className="
											rounded-sm text-text-secondary
											hover:text-accent
											focus-visible:ring-2 focus-visible:ring-accent
										"
									>
										Answers
									</button>
								)}
								{onBranch && message.role === 'assistant' && (
									<button
										id={`agent-branch-${transcriptId}-${message.id}`}
										className="
											rounded-sm text-text-secondary
											hover:text-accent
											focus-visible:ring-2 focus-visible:ring-accent
										"
										onClick={() => onBranch(message)}
									>
										Regenerate
									</button>
								)}
								{message.metadata?.snapshotId && onRestore && (
									<button
										id={`agent-restore-${transcriptId}-${message.id}`}
										className="
											rounded-sm text-text-secondary
											hover:text-accent
											focus-visible:ring-2 focus-visible:ring-accent
										"
										onClick={() => onRestore(message)}
									>
										Restore files
									</button>
								)}
							</div>
						)}
					</div>
					<div className="flex flex-col gap-2">
						{message.parts.map((part, index) => {
							if (part.type === 'text') return <MarkdownContent key={index} content={part.text} />;
							if (part.type === 'reasoning')
								return (
									<details
										key={index}
										className="
											rounded-md border border-border/60 px-2 text-xs text-text-secondary
										"
									>
										<summary
											id={`agent-reasoning-${transcriptId}-${message.id}-${index}`}
											className="
												cursor-pointer py-1.5
												focus-visible:outline-accent
											"
										>
											Reasoning
										</summary>
										<MarkdownContent content={part.text} />
									</details>
								);
							if (part.type === 'file' && part.mediaType.startsWith('image/'))
								return (
									<img
										key={index}
										src={part.url}
										alt={part.filename ?? 'Attached image'}
										className="
											max-h-64 max-w-full rounded-lg border border-border object-contain
										"
									/>
								);
							if (isToolUIPart(part))
								return (
									<NativeToolCard
										key={`${message.id}:${part.toolCallId}`}
										part={part}
										submissionId={message.metadata?.submissionId}
										state={
											message.metadata?.submissionId
												? message.metadata.submissionId === state?.activeSubmissionId
													? state
													: undefined
												: message.id === messages.at(-1)?.id
													? state
													: undefined
										}
										projectId={projectId}
										runs={runsByToolCallId[part.toolCallId]}
									/>
								);
							return;
						})}
					</div>
				</article>
			))}
		</div>
	);
}

function TaskCommandOutput({ data }: { data: unknown }) {
	const result = agentToolProgressSchema.safeParse(data);
	return result.success ? <CommandOutput output={result.data.commandOutput} /> : undefined;
}
