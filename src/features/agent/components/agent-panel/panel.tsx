import { useAgentChat } from '@cloudflare/think/react';
import { useQueryClient } from '@tanstack/react-query';
import { useAgent, useAgentToolEvents } from 'agents/react';
import { ArrowDown, Bot, ChevronDown, Download, History, RefreshCw, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { toast } from '@/components/ui/toast-store';
import { useMobileKeyboardLayout } from '@/hooks/use-mobile-keyboard-height';
import { createApiClient } from '@/lib/api-client';
import { throwApiError } from '@/lib/api-error';
import { getActiveSessionId } from '@/lib/project-storage';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { defaultAgentSettings, pendingAgentQuestion } from '@shared/agent-chat';
import { getModelLimits } from '@shared/constants';

import { AgentComposer } from './agent-composer';
import { AgentStatus } from './agent-status';
import { AgentTranscript } from './agent-transcript';
import { AgentBranchDialog } from './branch-dialog';
import { ContextRing } from './context-ring';
import { AgentSessionList } from './session-list';
import { downloadDebugLog } from '../../api/debug-log';
import { useAgentHistory } from '../../hooks/use-agent-history';
import { useAgentSessions } from '../../hooks/use-agent-sessions';
import { useAutoScroll } from '../../hooks/use-auto-scroll';
import { useChangeReview } from '../../hooks/use-change-review';
import { saveAgentDraftSession } from '../../lib/agent-draft-session';
import { regenerateAgentAnswer } from '../../lib/agent-regeneration';
import { prepareAgentSubmission, acknowledgeAgentSubmission } from '../../lib/agent-submission';
import { useAgentRuntime } from '../agent-runtime-context';
import { ChangedFilesSummary } from '../changed-files-summary';
import { RevertConfirmDialog } from '../revert-confirm-dialog';

import type { AgentMessage, ChatConfiguration, ChatState } from '@shared/agent-chat';
import type { SessionSummary } from '@shared/agent-state';
import type { UserMessagePart } from '@shared/types';
import type { UIMessage } from 'ai';

export function AgentPanel({ projectId, className }: { projectId: string; className?: string }) {
	const { agent, activeSessionId, selectSession, isConnected, setSegments } = useAgentRuntime();
	const sessions = useAgentSessions(projectId);
	const { ref: keyboardReference, style: keyboardStyle } = useMobileKeyboardLayout();
	const currentSession = sessions.allSessions.find((session) => session.id === activeSessionId);
	const [listOpen, setListOpen] = useState(false);
	const [settings, setSettings] = useState<Pick<ChatConfiguration, 'mode' | 'model'>>(() => ({
		...defaultAgentSettings,
		mode: useStore.getState().agentMode,
		model: useStore.getState().selectedModel,
	}));
	const api = useMemo(() => createApiClient(projectId), [projectId]);
	async function submit(parts: UserMessagePart[]) {
		const originalSession = activeSessionId;
		const submission = await prepareAgentSubmission(projectId, originalSession, parts);
		if (!originalSession) {
			const created = await api.agent.sessions.$post({ json: { id: submission.sessionId, ...settings } });
			if (!created.ok) await throwApiError(created, 'Could not create the session');
		}
		const response = await api.agent.sessions[':sessionId'].submissions.$post({
			param: { sessionId: submission.sessionId },
			json: { messageId: submission.messageId, parts },
		});
		if (!response.ok) await throwApiError(response, 'Could not send the message');
		acknowledgeAgentSubmission(submission.key);
		saveAgentDraftSession(`${projectId}:${originalSession ?? 'new'}`, { segments: [], cursorPosition: 0 });
		if (getActiveSessionId(projectId) === originalSession) {
			setSegments([]);
			if (!originalSession) selectSession(submission.sessionId);
		}
	}
	async function changeSettings(next: Pick<ChatConfiguration, 'mode' | 'model'>) {
		if (activeSessionId) {
			const response = await api.agent.sessions[':sessionId'].settings.$put({ param: { sessionId: activeSessionId }, json: next });
			if (!response.ok) await throwApiError(response, 'Could not update session settings');
		}
		setSettings(next);
	}
	return (
		<section
			ref={keyboardReference}
			style={keyboardStyle}
			className={cn('flex h-full min-h-0 flex-col bg-bg-secondary', className)}
			aria-label="Coding assistant"
		>
			<header
				className="
					flex h-11 shrink-0 items-center gap-2 border-b border-border px-3
				"
			>
				<Bot className="size-4 text-accent" aria-hidden />
				<button
					id="agent-session-menu"
					onClick={() => setListOpen((open) => !open)}
					aria-expanded={listOpen}
					className="
						flex min-w-0 flex-1 items-center gap-1 rounded-sm text-left text-xs
						font-semibold
						focus-visible:ring-2 focus-visible:ring-accent
					"
				>
					<span className="truncate">{currentSession?.title ?? 'New session'}</span>
					<ChevronDown className={cn('size-3.5 shrink-0 transition-transform', listOpen && 'rotate-180')} />
				</button>
				<span className="text-[10px] text-text-secondary">
					{sessions.allSessions.some((session) => session.isRunning)
						? `${sessions.allSessions.filter((session) => session.isRunning).length} running`
						: ''}
				</span>
				<button
					id="agent-toggle-history"
					aria-label="Session history"
					onClick={() => setListOpen((open) => !open)}
					className="
						rounded-sm p-1 text-text-secondary
						hover:text-text-primary
						focus-visible:ring-2 focus-visible:ring-accent
					"
				>
					<History className="size-4" />
				</button>
			</header>
			{listOpen && (
				<AgentSessionList
					sessions={sessions.sessions}
					selectedId={activeSessionId}
					query={sessions.query}
					onQuery={sessions.setQuery}
					onSelect={(id) => {
						selectSession(id);
						setListOpen(false);
					}}
					onNew={() => {
						selectSession();
						setListOpen(false);
					}}
					onRename={sessions.renameSession}
					onDelete={sessions.deleteSession}
				/>
			)}
			{currentSession ? (
				<ChatSessionPane
					key={currentSession.id}
					projectId={projectId}
					session={currentSession}
					onSubmit={submit}
					onSettings={(next) => void changeSettings(next).catch((error: unknown) => toast.error(String(error)))}
				/>
			) : (
				<>
					<div
						className="
							flex min-h-0 flex-1 flex-col justify-center gap-4 overflow-y-auto px-6
							py-8
						"
					>
						<div
							className="
								flex size-11 items-center justify-center rounded-xl border
								border-accent/20 bg-accent/10 text-accent
							"
						>
							<Bot className="size-6" />
						</div>
						<div>
							<h2 className="text-lg font-semibold tracking-tight">Build something.</h2>
							<p className="mt-1 text-sm text-text-secondary">Explore your project, make a plan, or start coding.</p>
						</div>
						{['Explain this project', 'Find a useful improvement', 'Review recent changes'].map((prompt, index) => (
							<button
								id={`agent-suggestion-${index}`}
								key={prompt}
								onClick={() => setSegments([{ type: 'text', value: prompt }])}
								className="
									rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-left
									text-xs text-text-secondary transition-colors
									hover:border-accent/40 hover:text-text-primary
									focus-visible:ring-2 focus-visible:ring-accent
								"
							>
								{prompt}
							</button>
						))}
					</div>
					{!isConnected && (
						<p role="status" className="px-3 py-2 text-xs text-text-secondary">
							{agent.state?.setupError ?? (agent.identified ? 'Preparing agent…' : 'Connecting…')}
						</p>
					)}
					<AgentComposer
						projectId={projectId}
						{...settings}
						busy={false}
						connected={isConnected}
						onSettings={(next) => setSettings(next)}
						onSubmit={submit}
						onStop={() => {}}
					/>
				</>
			)}
		</section>
	);
}

function ChatSessionPane({
	projectId,
	session,
	onSubmit,
	onSettings,
}: {
	projectId: string;
	session: SessionSummary;
	onSubmit: (parts: UserMessagePart[]) => Promise<void>;
	onSettings: (settings: Pick<ChatConfiguration, 'mode' | 'model'>) => void;
}) {
	const queryClient = useQueryClient();
	const connection = useAgent<ChatState>({
		agent: 'ProjectAgent',
		basePath: `p/${projectId}/__agent`,
		protocol: globalThis.location.protocol === 'https:' ? 'wss' : 'ws',
		sub: [{ agent: 'SessionTurnAgent', name: session.id }],
	});
	const chat = useAgentChat<ChatState, AgentMessage>({
		agent: connection,
		throttle: 100,
		onTurnEnd: () => {
			void queryClient.invalidateQueries({ queryKey: ['agent-history', projectId, session.id] });
		},
	});
	const tasks = useAgentToolEvents<UIMessage['parts'][number]>({ agent: connection });
	const state = connection.state;
	const [regenerationController, setRegenerationController] = useState<AbortController | undefined>();
	useEffect(() => () => regenerationController?.abort(), [regenerationController]);
	const busy = state?.status === 'running' || chat.isStreaming || chat.isRecovering || Boolean(regenerationController);
	const api = useMemo(() => createApiClient(projectId), [projectId]);
	const [versions, setVersions] = useState<AgentMessage | undefined>();
	const {
		messages,
		error: historyError,
		hasEarlier,
		loadingEarlier,
		loadEarlier,
	} = useAgentHistory(projectId, session.id, chat.messages.at(-1), chat.isStreaming || chat.isRecovering);
	const question = pendingAgentQuestion(messages);
	const { scrollReference, wrapperReference, anchorReference, hasNewContent, scrollToBottom } = useAutoScroll();
	const review = useChangeReview({ projectId });
	const [restore, setRestore] = useState<{ message: AgentMessage; snapshots: string[]; operationId: string } | undefined>();
	const [restoring, setRestoring] = useState(false);
	const [restoreError, setRestoreError] = useState<string | undefined>();
	const status = state?.stopRequested
		? 'Stopping…'
		: chat.isRecovering
			? 'Recovering…'
			: question && !busy
				? 'Waiting for your answer'
				: busy
					? (state?.statusText ?? 'Working…')
					: state?.finalizing
						? 'Finishing…'
						: state?.status === 'error'
							? 'Needs attention'
							: state?.status === 'aborted'
								? 'Stopped'
								: state?.status === 'completed'
									? 'Completed'
									: 'Ready';
	async function loadOlder() {
		try {
			await loadEarlier({ throwOnError: true });
		} catch (error) {
			toast.error(String(error));
		}
	}
	function regenerate(answerId?: string): void {
		const leaf: Pick<AgentMessage, 'id' | 'role'> | undefined = answerId ? { id: answerId, role: 'assistant' } : messages.at(-1);
		if (!leaf || busy) return;
		setVersions(undefined);
		const controller = new AbortController();
		setRegenerationController(controller);
		void regenerateAgentAnswer(projectId, session.id, leaf, chat, controller.signal)
			.catch((error: unknown) => {
				if (!controller.signal.aborted) toast.error(String(error));
			})
			.finally(() => setRegenerationController((current) => (current === controller ? undefined : current)));
	}
	async function stop() {
		regenerationController?.abort();
		setRegenerationController(undefined);
		await chat.stop();
		const response = await api.agent.sessions[':sessionId'].cancel.$post({ param: { sessionId: session.id } });
		if (!response.ok) await throwApiError(response, 'Could not stop the agent');
	}
	async function withdraw(id: string) {
		const response = await api.agent.sessions[':sessionId'].submissions[':submissionId'].$delete({
			param: { sessionId: session.id, submissionId: id },
		});
		if (!response.ok) await throwApiError(response, 'Could not remove the queued message');
	}
	async function restoreFiles() {
		if (!restore) return;
		setRestoring(true);
		setRestoreError(undefined);
		try {
			const response = await api.snapshots['revert-cascade'].$post({
				json: { snapshotIds: restore.snapshots, operationId: restore.operationId },
			});
			if (!response.ok) await throwApiError(response, 'Could not restore files');
			const result = await response.json();
			if (result.failed.length > 0 || result.missingSnapshots.length > 0)
				throw new Error(`Some files could not be restored (${result.failed.length + result.missingSnapshots.length}).`);
			setRestore(undefined);
			globalThis.dispatchEvent(new CustomEvent('preview-force-refresh'));
		} catch (error) {
			setRestoreError(error instanceof Error ? error.message : 'Restore failed');
		} finally {
			setRestoring(false);
		}
	}
	return (
		<>
			<div
				className="
					flex items-center justify-between border-b border-border/50 px-3 py-2
				"
			>
				<AgentStatus message={status} />
				<ContextRing tokensUsed={state?.contextTokensUsed ?? 0} contextWindow={getModelLimits(session.model).contextWindow} />
			</div>
			<div ref={wrapperReference} className="relative min-h-0 flex-1">
				<div ref={scrollReference} className="h-full overflow-y-auto px-3 py-4">
					{hasEarlier && (
						<button
							id="agent-load-earlier"
							disabled={loadingEarlier}
							onClick={() => void loadOlder()}
							className="
								mb-4 w-full rounded-lg border border-border py-2 text-xs
								text-text-secondary
								focus-visible:ring-2 focus-visible:ring-accent
							"
						>
							{loadingEarlier ? 'Loading…' : 'Load earlier messages'}
						</button>
					)}
					<AgentTranscript
						messages={messages}
						state={state}
						projectId={projectId}
						runsByToolCallId={tasks.runsByToolCallId}
						onBranch={(message) => regenerate(message.id)}
						onVersions={setVersions}
						onRestore={(message) => {
							const position = messages.findIndex((item) => item.id === message.id);
							const snapshots = [
								...new Set(messages.slice(position).flatMap((item) => (item.metadata?.snapshotId ? [item.metadata.snapshotId] : []))),
							];
							setRestore({ message, snapshots, operationId: crypto.randomUUID() });
						}}
					/>
					{question && !busy && (
						<section aria-label="Question" className="mt-4 rounded-xl border border-accent/30 bg-accent/5 p-3">
							<p className="text-sm">{question.question}</p>
							<div className="mt-3 flex flex-wrap gap-2">
								{question.options.map((option, index) => (
									<button
										id={`agent-answer-${index}`}
										key={option}
										className="
											rounded-lg border border-accent/30 px-3 py-1.5 text-xs text-accent
											hover:bg-accent/10
											focus-visible:ring-2 focus-visible:ring-accent
										"
										onClick={() => void onSubmit([{ type: 'text', content: option }]).catch((error: unknown) => toast.error(String(error)))}
									>
										{option}
									</button>
								))}
							</div>
						</section>
					)}
					{(state?.error || chat.error || historyError) && (
						<div
							role="alert"
							className="
								mt-4 rounded-lg border border-error/30 bg-error/5 p-3 text-xs text-error
							"
						>
							<p>{state?.error ?? chat.error?.message ?? historyError?.message}</p>
							<button
								id="agent-retry"
								onClick={() => regenerate()}
								disabled={busy}
								className="
									mt-2 flex items-center gap-1 rounded-sm
									focus-visible:ring-2 focus-visible:ring-accent
								"
							>
								<RefreshCw className="size-3" />
								Retry
							</button>
						</div>
					)}
					{state?.debugLogId && !busy && (
						<button
							id="agent-download-log"
							className="
								mt-4 flex items-center gap-1 rounded-sm text-xs text-text-secondary
								focus-visible:ring-2 focus-visible:ring-accent
							"
							onClick={() =>
								void downloadDebugLog(projectId, state.debugLogId ?? '', session.id).catch((error: unknown) => toast.error(String(error)))
							}
						>
							<Download className="size-3" />
							Agent log
						</button>
					)}
					<div ref={anchorReference} className="h-px" />
				</div>
				{hasNewContent && (
					<button
						id="agent-scroll-bottom"
						onClick={scrollToBottom}
						className="
							absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1
							rounded-full border border-border bg-bg-primary px-3 py-1.5 text-xs
							shadow-sm
							focus-visible:ring-2 focus-visible:ring-accent
						"
					>
						<ArrowDown className="size-3" />
						Latest
					</button>
				)}
			</div>
			{review.sessionPendingCount(session.id) > 0 && (
				<div className="max-h-56 shrink-0 overflow-auto border-t border-border p-2">
					<ChangedFilesSummary
						sessionId={session.id}
						onApproveChange={review.handleApproveChange}
						onRejectChange={review.handleRejectChange}
						onApproveAll={() => review.handleApproveAll(session.id)}
						onRejectAll={() => review.handleRejectAll(session.id)}
						isReverting={review.isReverting}
						canReject={review.canReject}
					/>
				</div>
			)}
			{state?.queuedMessages.map((message) => (
				<div
					key={message.id}
					className="
						flex items-center gap-2 border-t border-border/50 px-3 py-2 text-xs
						text-text-secondary
					"
				>
					<span className="shrink-0">Queued</span>
					<span className="min-w-0 flex-1 truncate">{message.text}</span>
					<button
						id={`agent-withdraw-${message.id}`}
						aria-label="Remove queued message"
						className="
							rounded-sm
							focus-visible:ring-2 focus-visible:ring-accent
						"
						onClick={() => void withdraw(message.id).catch((error: unknown) => toast.error(String(error)))}
					>
						<X className="size-3" />
					</button>
				</div>
			))}
			<AgentComposer
				projectId={projectId}
				mode={state?.configuration?.mode ?? session.mode}
				model={state?.configuration?.model ?? session.model}
				busy={busy}
				settingsDisabled={state?.finalizing}
				connected={connection.identified}
				onSettings={onSettings}
				onSubmit={onSubmit}
				onStop={() => void stop().catch((error: unknown) => toast.error(String(error)))}
			/>
			{versions && (
				<AgentBranchDialog
					key={versions.id}
					projectId={projectId}
					sessionId={session.id}
					message={versions}
					onClose={() => setVersions(undefined)}
					onRegenerate={regenerate}
				/>
			)}
			<RevertConfirmDialog
				open={Boolean(restore)}
				onOpenChange={(open) => {
					if (!open) setRestore(undefined);
				}}
				snapshotIds={restore?.snapshots ?? []}
				messageIndex={0}
				projectId={projectId}
				onConfirm={() => void restoreFiles()}
				isReverting={restoring}
				revertError={restoreError}
			/>
		</>
	);
}
