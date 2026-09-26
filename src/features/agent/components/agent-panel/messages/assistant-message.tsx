import { ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

import { InlineToolCall } from './tool-call';
import { isToolResultPart, isTextPart, isReasoningPart, isToolCallPart } from './tool-result-format';
import { MarkdownContent } from '../../markdown-content';

import type { SubAgentActivityRecord } from '@shared/agent-state';
import type { ChatMessage, MessagePart, ToolCallPart, ToolErrorInfo, ToolMetadataInfo, ToolResultPart } from '@shared/types';

const THINKING_BOX_BOTTOM_THRESHOLD = 16;

/**
 * Build a list of renderable segments from ChatMessage parts, preserving order.
 * Groups adjacent text parts, pairs tool-call with their tool-result.
 */
type RenderSegment =
	| { kind: 'text'; key: string; text: string }
	| { kind: 'thinking'; key: string; text: string }
	| { kind: 'tool'; key: string; toolCall: ToolCallPart; toolResult?: ToolResultPart };

function buildRenderSegments(parts: MessagePart[]): RenderSegment[] {
	const segments: RenderSegment[] = [];

	// Collect tool results into a lookup so we can pair them with tool calls
	const resultsByCallId = new Map<string, ToolResultPart>();
	for (const part of parts) {
		if (isToolResultPart(part)) {
			resultsByCallId.set(part.toolCallId, part);
		}
	}

	// Counters for generating stable keys per segment kind
	let textCount = 0;
	let thinkingCount = 0;

	for (const part of parts) {
		if (isTextPart(part)) {
			const raw = (part.content ?? '').trim();
			if (!raw) continue;
			// Merge consecutive text segments
			const last = segments.at(-1);
			if (last?.kind === 'text') {
				last.text += '\n' + raw;
			} else {
				segments.push({ kind: 'text', key: `text-${textCount++}`, text: raw });
			}
		} else if (isReasoningPart(part)) {
			const cleaned = (part.content ?? '').trim();
			if (!cleaned) continue;
			segments.push({ kind: 'thinking', key: `thinking-${thinkingCount++}`, text: cleaned });
		} else if (isToolCallPart(part)) {
			const result = resultsByCallId.get(part.toolCallId);
			segments.push({ kind: 'tool', key: part.toolCallId, toolCall: part, toolResult: result });
		}
		// tool-result parts are consumed via the lookup above
	}
	return segments;
}

export function AssistantMessage({
	message,
	streaming,
	toolErrors,
	toolMetadata,
	fileDiffContent,
	subAgentActivities,
	projectId,
	showHeader = true,
}: {
	message: ChatMessage;
	streaming?: boolean;
	toolErrors?: Map<string, ToolErrorInfo>;
	toolMetadata?: Map<string, ToolMetadataInfo>;
	fileDiffContent?: Map<string, { beforeContent: string; afterContent: string }>;
	subAgentActivities?: Record<string, SubAgentActivityRecord>;
	projectId?: string;
	showHeader?: boolean;
}) {
	const segments = buildRenderSegments(message.parts);
	const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
	const scrollReference = useRef<HTMLDivElement>(null);
	const userScrolledAwayReference = useRef(false);

	const hasToolCalls = segments.some((segment) => segment.kind === 'tool');

	// Auto-scroll the active streaming thinking box (respects user scroll-up)
	useEffect(() => {
		if (streaming && scrollReference.current && !userScrolledAwayReference.current) {
			scrollReference.current.scrollTop = scrollReference.current.scrollHeight;
		}
	}, [streaming, message.parts]);

	// Reset scroll-away flag when streaming starts (new thinking box appears)
	useEffect(() => {
		if (streaming) {
			userScrolledAwayReference.current = false;
		}
	}, [streaming]);

	const handleThinkingBoxScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
		const element = event.currentTarget;
		const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
		userScrolledAwayReference.current = distanceFromBottom > THINKING_BOX_BOTTOM_THRESHOLD;
	}, []);

	// Don't render anything for assistant messages with no visible segments
	// (e.g. messages containing only tool-result parts with no matching tool-call).
	if (segments.length === 0 && !streaming) {
		return;
	}

	const toggleSection = (key: string) => {
		setExpandedSections((previous) => {
			const next = new Set(previous);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			return next;
		});
	};

	// Simple Q&A mode: no tool calls and not streaming — render text normally
	if (!hasToolCalls && !streaming) {
		return (
			<div className="flex min-w-0 animate-chat-item flex-col gap-2">
				{showHeader && <div className="text-2xs font-semibold tracking-wider text-success uppercase">AI</div>}
				{segments.map((segment) => {
					if (segment.kind === 'text') {
						return (
							<div
								key={segment.key}
								className="
									overflow-hidden rounded-lg bg-bg-tertiary px-3 py-2.5 text-sm/relaxed
									text-text-primary
								"
							>
								<MarkdownContent content={segment.text} />
							</div>
						);
					}
					if (segment.kind === 'thinking') {
						const isExpanded = expandedSections.has(segment.key);
						return (
							<div key={segment.key} className="flex flex-col gap-1.5">
								<button
									type="button"
									onClick={() => toggleSection(segment.key)}
									className={cn(
										`
											flex items-center gap-2 overflow-hidden rounded-md px-3 py-1.5
											text-xs
										`,
										`
											cursor-pointer bg-bg-tertiary font-medium text-text-secondary
											transition-colors
											hover:bg-border
										`,
									)}
								>
									<ChevronRight className={cn('size-3 shrink-0 transition-transform', isExpanded && 'rotate-90')} />
									Show thinking
								</button>
								{isExpanded && (
									<div
										className="
											overflow-hidden rounded-lg bg-bg-tertiary px-3 py-2.5 text-sm/relaxed
											text-text-primary
										"
									>
										<MarkdownContent content={segment.text} />
									</div>
								)}
							</div>
						);
					}
					return;
				})}
			</div>
		);
	}

	// Interleaved thinking + tool calls + text layout
	const lastSegmentIndex = segments.length - 1;

	return (
		<div className="flex min-w-0 animate-chat-item flex-col gap-2">
			{showHeader && <div className="text-2xs font-semibold tracking-wider text-success uppercase">AI</div>}
			{segments.map((segment, index) => {
				// ── Tool calls ───────────────────────────────────────
				if (segment.kind === 'tool') {
					return (
						<InlineToolCall
							key={segment.key}
							toolCall={segment.toolCall}
							toolResult={segment.toolResult}
							toolErrors={toolErrors}
							toolMetadata={toolMetadata}
							fileDiffContent={fileDiffContent}
							subAgentActivities={subAgentActivities}
							projectId={projectId}
							isStreaming={streaming}
							isExpanded={expandedSections.has(segment.key)}
							onToggleExpand={() => toggleSection(segment.key)}
						/>
					);
				}

				// ── Thinking segments — always height-bounded ────────
				if (segment.kind === 'thinking') {
					// A thinking segment is the "active streaming" box only when it
					// is the very last segment and we're still streaming. As soon as
					// any subsequent segment appears (text, tool, or another thinking
					// block), this one collapses into the "Show thinking" toggle.
					const isActiveStreamingThinking = streaming && index === lastSegmentIndex;

					if (isActiveStreamingThinking) {
						return (
							<div
								key={segment.key}
								ref={scrollReference}
								onScroll={handleThinkingBoxScroll}
								className="
									max-h-48 overflow-y-auto rounded-lg border border-text-secondary/15
									bg-bg-tertiary
								"
							>
								<div className="p-2.5">
									<div className="overflow-hidden text-xs/relaxed text-text-secondary italic">
										<MarkdownContent content={segment.text} />
									</div>
								</div>
							</div>
						);
					}

					// Completed or superseded thinking — always collapsible
					const isExpanded = expandedSections.has(segment.key);
					return (
						<div key={segment.key} className="flex flex-col gap-1.5">
							<button
								type="button"
								onClick={() => toggleSection(segment.key)}
								className={cn(
									'flex items-center gap-2 rounded-md px-3 py-1.5 text-xs',
									`
										cursor-pointer bg-bg-tertiary font-medium text-text-secondary
										transition-colors
									`,
									'hover:bg-border',
								)}
							>
								<ChevronRight className={cn('size-3 shrink-0 transition-transform', isExpanded && 'rotate-90')} />
								Show thinking
							</button>
							{isExpanded && (
								<div
									className="
										max-h-64 overflow-y-auto rounded-lg border border-text-secondary/10
										bg-bg-tertiary px-3 py-2.5 text-xs/relaxed text-text-secondary italic
									"
								>
									<MarkdownContent content={segment.text} />
								</div>
							)}
						</div>
					);
				}

				// ── Text segments ────────────────────────────────────
				// Active streaming text: bounded height with auto-scroll
				if (streaming && index === lastSegmentIndex) {
					return (
						<div
							key={segment.key}
							ref={scrollReference}
							onScroll={handleThinkingBoxScroll}
							className="
								max-h-48 overflow-y-auto rounded-lg border border-accent/20
								bg-bg-tertiary
							"
						>
							<div className="p-2.5">
								<div className="overflow-hidden text-sm/relaxed text-text-primary">
									<MarkdownContent content={segment.text} />
								</div>
							</div>
						</div>
					);
				}

				// Completed text — fully visible in flow
				return (
					<div
						key={segment.key}
						className="
							overflow-hidden rounded-lg bg-bg-tertiary px-3 py-2.5 text-sm/relaxed
							text-text-primary
						"
					>
						<MarkdownContent content={segment.text} />
					</div>
				);
			})}
		</div>
	);
}
