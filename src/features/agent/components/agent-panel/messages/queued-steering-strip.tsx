import { X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import { Pill } from '@/components/ui/pill';
import { cn } from '@/lib/utils';
import { messagePartsToPlainText } from '@shared/chat-message-parts';

import { resolveAuthorName, resolveAuthorColor } from './message-author';

import type { SessionParticipantProfile } from '@shared/agent-state';
import type { ChatMessage } from '@shared/types';

function abbreviateQueuedMessage(content: string, maxLength = 72): string {
	const normalized = content.replaceAll(/\s+/g, ' ').trim();
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
}

const QUEUED_PREVIEW_LIMIT = 3;

function getQueuedMessageText(message: ChatMessage): string {
	return messagePartsToPlainText(message.parts);
}

export function QueuedSteeringStrip({
	messages,
	currentUserId,
	sessionParticipants,
	localOnlyMessageIds,
	onRemoveMessage,
}: {
	messages: ChatMessage[];
	currentUserId?: string;
	sessionParticipants: Record<string, SessionParticipantProfile>;
	localOnlyMessageIds?: Set<string>;
	onRemoveMessage: (messageId: string) => void;
}) {
	const [isExpanded, setIsExpanded] = useState(false);
	const rootReference = useRef<HTMLDivElement>(null);
	const orderedMessages = useMemo(() => [...messages], [messages]);
	const stackDepth = Math.min(messages.length, QUEUED_PREVIEW_LIMIT);
	const handleRemoveMessage = useCallback(
		(messageId: string) => {
			setIsExpanded(true);
			onRemoveMessage(messageId);
		},
		[onRemoveMessage],
	);

	useEffect(() => {
		if (!isExpanded) return;

		const handlePointerDown = (event: PointerEvent) => {
			if (!(event.target instanceof Node) || !rootReference.current?.contains(event.target)) {
				setIsExpanded(false);
			}
		};

		globalThis.addEventListener('pointerdown', handlePointerDown);
		return () => globalThis.removeEventListener('pointerdown', handlePointerDown);
	}, [isExpanded]);

	return (
		<div
			ref={rootReference}
			className="relative z-20 h-10 touch-pan-y overflow-visible"
			style={{ height: 44 } satisfies CSSProperties}
			onMouseEnter={() => setIsExpanded(true)}
			onMouseLeave={() => setIsExpanded(false)}
		>
			<AnimatePresence initial={false}>
				{orderedMessages.map((message, index) => {
					const collapsedIndex = Math.min(index, stackDepth - 1);
					const offset = isExpanded ? index * 42 : collapsedIndex * 4;
					const hiddenWhenCollapsed = !isExpanded && index >= stackDepth;
					const isFrontCard = index === 0;
					const previewText = abbreviateQueuedMessage(getQueuedMessageText(message), 64);
					const isInteractiveCard = isExpanded || isFrontCard;
					const isClientOnly = localOnlyMessageIds?.has(message.id) ?? false;
					const authorName = resolveAuthorName(message.authorUserId, currentUserId, sessionParticipants);
					const authorColor = resolveAuthorColor(message.authorUserId, sessionParticipants);

					return (
						<motion.div
							key={message.id}
							layout={isExpanded ? 'position' : false}
							initial={{ y: -(offset + 8), opacity: 0 }}
							animate={{ y: -offset, opacity: hiddenWhenCollapsed ? 0 : 1 }}
							exit={{ y: -(offset + 8), opacity: 0 }}
							transition={{ duration: 0.14, ease: 'easeOut' }}
							className={cn('absolute inset-x-0 bottom-0', hiddenWhenCollapsed && 'pointer-events-none')}
							style={{ zIndex: orderedMessages.length - index }}
						>
							<div
								className={cn(
									`
										flex h-10 items-center gap-0.5 rounded-lg border px-3
										transition-colors duration-120
									`,
									`
										border-purple-500/25
										bg-[color-mix(in_oklab,var(--color-bg-secondary)_90%,var(--color-purple-500)_10%)]
										shadow-[inset_0_0_0_1px_rgba(168,85,247,0.05)]
									`,
									isClientOnly && 'border-dashed',
									'pr-2',
									isFrontCard && !isExpanded
										? `
											hover:border-purple-500/40
											hover:bg-[color-mix(in_oklab,var(--color-bg-secondary)_88%,var(--color-purple-500)_12%)]
										`
										: undefined,
								)}
							>
								{isFrontCard ? (
									<button
										type="button"
										onClick={() => setIsExpanded((current) => !current)}
										className="flex min-w-0 flex-1 items-center gap-2 text-left"
										aria-label={isExpanded ? 'Hide queued messages' : `Show ${messages.length} queued messages`}
									>
										<div className="flex min-w-0 flex-1 items-center gap-2">
											<Pill size="xs" color="purple" className="whitespace-nowrap">
												{messages.length}
											</Pill>
											<span
												className="size-2.5 shrink-0 rounded-full border border-white/15"
												style={authorColor ? { backgroundColor: authorColor } : undefined}
												title={authorName}
											/>
											<span className="min-w-0 truncate text-sm font-medium text-text-primary">{previewText}</span>
										</div>
									</button>
								) : isExpanded ? (
									<div className="flex min-w-0 flex-1 items-center gap-2 text-left">
										<span
											className="size-2.5 shrink-0 rounded-full border border-white/15"
											style={authorColor ? { backgroundColor: authorColor } : undefined}
											title={authorName}
										/>
										<span className="min-w-0 truncate text-sm font-medium text-text-primary">{previewText}</span>
									</div>
								) : (
									<div aria-hidden className="flex min-w-0 flex-1 items-center" />
								)}
								<button
									type="button"
									onClick={() => handleRemoveMessage(message.id)}
									disabled={!isInteractiveCard}
									className={cn(
										`
											inline-flex size-6 shrink-0 items-center justify-center rounded-md
											border transition-colors
										`,
										`
											border-purple-500/20 text-text-secondary
											hover:border-purple-500/35 hover:bg-purple-500/10
											hover:text-text-primary
										`,
										!isInteractiveCard && 'pointer-events-none opacity-0',
									)}
									aria-label={isInteractiveCard ? 'Remove queued message' : undefined}
									tabIndex={isInteractiveCard ? 0 : -1}
								>
									<X className="size-3.5" />
								</button>
							</div>
						</motion.div>
					);
				})}
			</AnimatePresence>
		</div>
	);
}
