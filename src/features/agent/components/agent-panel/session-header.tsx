import { History, Pencil, Plus, Square, Trash2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { InlineConfirmGroup } from '@/components/ui/inline-confirm-group';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast-store';
import { Tooltip } from '@/components/ui/tooltip';
import { tweenFast } from '@/lib/motion-config';
import { cn, formatRelativeTime } from '@/lib/utils';
import { sessionTitleSchema } from '@shared/validation';

import type { AgentConnectionState } from '../agent-runtime-context';
import type { SessionSummary } from '@shared/agent-state';

type AgentSessionHeaderProperties = {
	hasSession: boolean;
	allSessions: SessionSummary[];
	savedSessions: SessionSummary[];
	sessionId: string | undefined;
	isConnected: boolean;
	agentConnectionState: AgentConnectionState;
	isProcessing: boolean;
	isStopPending: boolean;
	needsAttention: boolean;
	sessionSearchQuery: string;
	setSessionSearchQuery: (query: string) => void;
	handleLoadSession: (sessionId: string) => void;
	handleRenameSession: (sessionId: string, title: string) => Promise<boolean>;
	handleDeleteSession: (sessionId: string) => Promise<boolean>;
	handleCancel: () => void;
	clearHistory: () => void;
};

export function AgentSessionHeader({
	hasSession,
	allSessions,
	savedSessions,
	sessionId,
	isConnected,
	agentConnectionState,
	isProcessing,
	isStopPending,
	needsAttention,
	sessionSearchQuery,
	setSessionSearchQuery,
	handleLoadSession,
	handleRenameSession,
	handleDeleteSession,
	handleCancel,
	clearHistory,
}: AgentSessionHeaderProperties) {
	const [isRenamingSessionTitle, setIsRenamingSessionTitle] = useState(false);
	const [renameValue, setRenameValue] = useState('');
	const [confirmingDeleteSessionId, setConfirmingDeleteSessionId] = useState<string | undefined>();
	const [deletingSessionId, setDeletingSessionId] = useState<string | undefined>();
	const deleteTriggerReferences = useRef<Map<string, HTMLButtonElement>>(new Map());

	const focusDeleteTrigger = useCallback((sessionIdentifier: string) => {
		requestAnimationFrame(() => {
			deleteTriggerReferences.current.get(sessionIdentifier)?.focus();
		});
	}, []);

	const handleStartRenameSessionTitle = useCallback(() => {
		if (!sessionId) return;
		const currentSession = allSessions.find((session) => session.id === sessionId);
		setRenameValue(currentSession?.title ?? 'New session');
		setIsRenamingSessionTitle(true);
	}, [allSessions, sessionId]);

	const handleSubmitRenameSessionTitle = useCallback(
		async (value: string) => {
			if (!sessionId) return;
			const parsed = sessionTitleSchema.safeParse(value);
			if (!parsed.success) {
				toast.error(parsed.error.issues[0]?.message ?? 'Invalid title');
				return;
			}

			const success = await handleRenameSession(sessionId, parsed.data);
			if (success) {
				setRenameValue(parsed.data);
				setIsRenamingSessionTitle(false);
			}
		},
		[handleRenameSession, sessionId],
	);

	const currentSession = allSessions.find((session) => session.id === sessionId);
	const sessionTitle = currentSession?.title ?? 'New session';

	// Status dot: session state takes priority over connection state
	let statusDotClassName: string;
	let statusTooltip: string;
	if (!isConnected) {
		statusDotClassName = agentConnectionState === 'connecting' ? 'animate-pulse bg-text-secondary/50' : 'animate-pulse bg-error';
		statusTooltip = agentConnectionState === 'connecting' ? 'Connecting…' : 'Reconnecting…';
	} else if (isProcessing) {
		statusDotClassName = 'animate-pulse bg-warning';
		statusTooltip = 'Generating…';
	} else if (needsAttention) {
		statusDotClassName = 'animate-pulse bg-accent';
		statusTooltip = 'Waiting for input';
	} else {
		statusDotClassName = 'bg-success';
		statusTooltip = 'Ready';
	}

	return (
		<div
			className="
				relative flex h-9 shrink-0 items-center gap-2 border-b border-border px-3
			"
		>
			{/* Left: status dot + session title + pencil (or plain label) */}
			<div className="group flex min-w-0 flex-1 items-center gap-2">
				{hasSession && (
					<Tooltip content={statusTooltip} side="bottom">
						<span className={cn('size-1.5 shrink-0 rounded-full transition-colors', statusDotClassName)} />
					</Tooltip>
				)}
				{hasSession ? (
					<>
						<button
							type="button"
							onClick={handleStartRenameSessionTitle}
							className="
								min-w-0 cursor-pointer truncate text-xs font-medium text-text-secondary
							"
							title={sessionTitle}
							aria-label="Rename session"
						>
							{sessionTitle}
						</button>
						<Tooltip content="Rename session" side="bottom">
							<button
								type="button"
								onClick={handleStartRenameSessionTitle}
								className="
									shrink-0 cursor-pointer text-text-secondary opacity-0
									transition-opacity
									pointer-coarse:hidden
									hover-always:text-accent
									group-hover-always:opacity-100
								"
								aria-label="Rename session"
							>
								<Pencil className="size-3" />
							</button>
						</Tooltip>
					</>
				) : (
					<span className="truncate text-xs font-medium text-text-secondary">Agent</span>
				)}
			</div>

			{/* Absolute rename overlay — sits on top of the header, avoids overflow clipping */}
			{isRenamingSessionTitle && (
				<div className="absolute inset-0 z-10 flex items-center px-3">
					<input
						autoFocus
						type="text"
						defaultValue={renameValue || sessionTitle}
						onKeyDown={(event) => {
							if (event.key === 'Enter') {
								event.preventDefault();
								void handleSubmitRenameSessionTitle(event.currentTarget.value);
							}
							if (event.key === 'Escape') {
								event.preventDefault();
								setIsRenamingSessionTitle(false);
							}
						}}
						onBlur={(event) => {
							void handleSubmitRenameSessionTitle(event.currentTarget.value);
						}}
						maxLength={80}
						aria-label="Rename session"
						className="
							h-6 w-full rounded-sm border border-accent bg-bg-primary px-1.5 text-xs
							text-text-primary shadow-sm
							focus:outline-none
						"
					/>
				</div>
			)}

			{/* Right: action buttons */}
			<div className="flex shrink-0 items-center gap-1">
				{hasSession && (
					<>
						<AnimatePresence initial={false}>
							{isProcessing && (
								<motion.div
									initial={{ opacity: 0, x: 4, scale: 0.96 }}
									animate={{ opacity: 1, x: 0, scale: 1 }}
									exit={{ opacity: 0, x: 4, scale: 0.96 }}
									transition={tweenFast}
									className="shrink-0"
								>
									<Tooltip content={isStopPending ? 'Stopping generation' : 'Stop generation'} side="bottom">
										<Button
											type="button"
											focusStyle="inset"
											variant="ghost"
											size="icon-sm"
											onClick={handleCancel}
											disabled={!isConnected}
											isLoading={isStopPending}
											className={cn('text-error', isConnected ? 'hover:bg-error/10 hover:text-error' : 'opacity-40')}
											aria-label={isStopPending ? 'Stopping generation' : 'Stop generation'}
										>
											<Square className="size-3.5" />
										</Button>
									</Tooltip>
								</motion.div>
							)}
						</AnimatePresence>
					</>
				)}
				<DropdownMenu
					onOpenChange={(open) => {
						if (!open) setConfirmingDeleteSessionId(undefined);
					}}
				>
					<Tooltip content="Sessions" side="bottom">
						<DropdownMenuTrigger>
							<Button focusStyle="inset" variant="ghost" size="icon" className="size-7" aria-label="Sessions">
								<History className="size-3.5" />
							</Button>
						</DropdownMenuTrigger>
					</Tooltip>
					<DropdownMenuContent align="end" className="max-h-80 w-64 overflow-y-auto">
						<div className="border-b border-border p-2">
							<input
								type="text"
								value={sessionSearchQuery}
								onChange={(event) => setSessionSearchQuery(event.target.value)}
								onKeyDown={(event) => event.stopPropagation()}
								placeholder="Search session history..."
								className="
									w-full rounded-sm border border-border bg-bg-primary px-2 py-1 text-xs
									text-text-primary outline-none
									focus:border-accent
								"
							/>
						</div>
						{savedSessions.length === 0 ? (
							<div className="px-3 py-2 text-xs text-text-secondary">
								{sessionSearchQuery.trim() ? 'No matching sessions' : 'No recent sessions'}
							</div>
						) : (
							savedSessions.map((session) => (
								<DropdownMenuItem key={session.id} className="group" onSelect={() => handleLoadSession(session.id)}>
									<div className="flex w-full items-center justify-between gap-2" title={session.title}>
										<span className="truncate text-sm">{session.title}</span>
										<div className="flex shrink-0 items-center gap-1">
											{deletingSessionId === session.id ? (
												<Spinner className="size-3 text-text-secondary" />
											) : (
												confirmingDeleteSessionId !== session.id && (
													<>
														{session.isRunning && <Spinner className="size-3 text-warning" />}
														<span className={cn('text-2xs text-text-secondary', 'group-hover:hidden')}>
															{formatRelativeTime(session.createdAt)}
														</span>
													</>
												)
											)}
											{deletingSessionId === session.id ? undefined : confirmingDeleteSessionId === session.id ? (
												<InlineConfirmGroup
													itemName={session.title}
													onConfirm={() => {
														setConfirmingDeleteSessionId(undefined);
														setDeletingSessionId(session.id);
														if (session.id === sessionId) {
															clearHistory();
														}
														void handleDeleteSession(session.id).finally(() => {
															setDeletingSessionId((current) => (current === session.id ? undefined : current));
														});
													}}
													onCancel={() => {
														setConfirmingDeleteSessionId(undefined);
														focusDeleteTrigger(session.id);
													}}
												/>
											) : (
												<button
													type="button"
													ref={(element) => {
														if (element) {
															deleteTriggerReferences.current.set(session.id, element);
															return;
														}
														deleteTriggerReferences.current.delete(session.id);
													}}
													onClick={(event) => {
														event.stopPropagation();
														setConfirmingDeleteSessionId(session.id);
													}}
													className={cn(
														`
															hidden cursor-pointer rounded-sm p-0.5 text-text-secondary
															transition-colors
														`,
														`
															group-focus-within:flex
															group-hover-always:flex
														`,
														'hover:bg-bg-tertiary hover:text-error',
													)}
													aria-label={`Delete ${session.title}`}
												>
													<Trash2 className="size-3" />
												</button>
											)}
										</div>
									</div>
								</DropdownMenuItem>
							))
						)}
					</DropdownMenuContent>
				</DropdownMenu>
				{hasSession && (
					<Tooltip content="New session" side="bottom">
						<Button
							focusStyle="inset"
							variant="ghost"
							size="icon"
							className="size-7"
							aria-label="New session"
							onClick={clearHistory}
							disabled={!isConnected}
						>
							<Plus className="size-3.5" />
						</Button>
					</Tooltip>
				)}
			</div>
		</div>
	);
}
