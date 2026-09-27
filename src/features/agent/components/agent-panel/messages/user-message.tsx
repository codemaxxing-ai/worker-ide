import { RotateCcw } from 'lucide-react';
import { motion } from 'motion/react';
import { useMemo } from 'react';

import { Button } from '@/components/ui/button';
import { Pill, type PillProperties } from '@/components/ui/pill';
import { Tooltip } from '@/components/ui/tooltip';
import { fadeUpVariants, springDefault } from '@/lib/motion-config';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';

import { messagePartsToInputSegments } from '../../../lib/input-segments';
import { FileReference } from '../../file-reference';
import { PreviewElementReference } from '../../preview-element-reference';
import { getModelLabel } from '../model-config';
import { resolveAuthorName } from './message-author';

import type { SessionParticipantProfile } from '@shared/agent-state';
import type { AgentMode, ChatMessage } from '@shared/types';

/**
 * Mode-specific border and background colors for user message bubbles.
 * Falls back to the default accent color when no mode is provided.
 */
const MODE_BUBBLE_STYLES: Record<AgentMode, string> = {
	code: 'border-emerald-500/25 bg-emerald-500/8',
	plan: 'border-amber-500/25 bg-amber-500/8',
	ask: 'border-sky-500/25 bg-sky-500/8',
};

const MODE_BADGE_STYLES: Record<AgentMode, { label: string; pillColor: NonNullable<PillProperties['color']> }> = {
	code: { label: 'Code', pillColor: 'emerald' },
	plan: { label: 'Plan', pillColor: 'amber' },
	ask: { label: 'Ask', pillColor: 'sky' },
};

export function UserMessage({
	message,
	messageIndex,
	currentUserId,
	sessionParticipants,
	agentMode,
	modelId,
	isClientOnly,
	canRevert,
	isReverting,
	isRevertingThis,
	onRevert,
}: {
	message: ChatMessage;
	messageIndex: number;
	currentUserId?: string;
	sessionParticipants: Record<string, SessionParticipantProfile>;
	agentMode?: AgentMode;
	modelId?: string;
	isClientOnly: boolean;
	canRevert: boolean;
	isReverting: boolean;
	isRevertingThis: boolean;
	onRevert: (messageIndex: number) => void;
}) {
	// Build a set of known file paths to identify file mentions
	const files = useStore((state) => state.files);
	const knownPaths = useMemo(() => new Set(files.map((file) => file.path)), [files]);
	const segments = useMemo(() => messagePartsToInputSegments(message.parts, knownPaths), [message.parts, knownPaths]);
	const imageParts = useMemo(() => message.parts.filter((part) => part.type === 'image'), [message.parts]);
	const hasTextSegments = segments.length > 0;

	const bubbleStyle = agentMode ? MODE_BUBBLE_STYLES[agentMode] : 'border-accent/20 bg-accent/10';
	const badge = agentMode ? MODE_BADGE_STYLES[agentMode] : undefined;
	const modelLabel = modelId ? getModelLabel(modelId) : undefined;
	const authorName = resolveAuthorName(message.authorUserId, currentUserId, sessionParticipants);

	return (
		<motion.div
			className="flex min-w-0 flex-col gap-1"
			variants={fadeUpVariants}
			initial="hidden"
			animate="visible"
			transition={springDefault}
		>
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-1.5">
					<span className="text-2xs font-semibold tracking-wider text-accent">{authorName}</span>
					{badge && (
						<Pill size="xs" color={badge.pillColor}>
							{badge.label}
						</Pill>
					)}
					{modelLabel && <Pill size="xs">{modelLabel}</Pill>}
				</div>
				{canRevert && (
					<Tooltip content="Revert the session to before this message">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => onRevert(messageIndex)}
							disabled={isReverting}
							isLoading={isRevertingThis}
							className={cn('h-auto px-1.5 py-0.5 text-2xs font-medium text-text-secondary', 'hover:bg-warning/10 hover:text-warning')}
						>
							<RotateCcw className="size-3" />
							Revert
						</Button>
					</Tooltip>
				)}
			</div>
			<div
				className={cn('rounded-lg border px-3 py-2.5', bubbleStyle, isClientOnly && 'border-dashed', 'text-sm/relaxed text-text-primary')}
			>
				{imageParts.length > 0 && (
					<div className={cn('flex flex-wrap gap-1.5', hasTextSegments && 'mb-2')}>
						{imageParts.map((part, index) => (
							<a
								key={index}
								href={part.url}
								target="_blank"
								rel="noreferrer"
								className="
									block size-20 overflow-hidden rounded-md border border-border/60
									bg-bg-secondary
								"
							>
								<img src={part.url} alt={part.name ?? 'Attached image'} className="size-full object-cover" />
							</a>
						))}
					</div>
				)}
				{hasTextSegments && (
					<span className="whitespace-pre-wrap">
						{segments.map((segment, index) =>
							segment.type === 'mention' ? (
								<FileReference key={index} path={segment.path} />
							) : segment.type === 'preview-element' ? (
								<PreviewElementReference key={index} reference={segment} />
							) : (
								<span key={index}>{segment.value}</span>
							),
						)}
					</span>
				)}
			</div>
		</motion.div>
	);
}
