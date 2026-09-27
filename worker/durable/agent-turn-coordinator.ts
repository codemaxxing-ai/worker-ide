import { getActiveThinkMessages, mergeThinkHistory } from './agent-runner-helpers';

import type { ActiveThinkSubmission } from './agent-runner-helpers';
import type { AgentSessionStore } from './session-store';
import type { TurnExecutionConfiguration } from './session-turn-agent';
import type { ReviewQueueStore } from '../services/agent/review-queue';
import type { AgentSessionState } from '@shared/agent-state';
import type { AIModelId } from '@shared/constants';
import type { ChatMessage } from '@shared/types';

interface SessionTurnPort {
	submitTurn(
		message: ChatMessage,
		configuration: TurnExecutionConfiguration,
	): Promise<{ accepted: boolean; status: string; submissionId: string }>;
	replaceHistory(messages: ChatMessage[]): Promise<void>;
	cancelSubmissionById(submissionId: string): Promise<void>;
	cancelActiveSubmissions(): Promise<void>;
}

interface AgentTurnCoordinatorDependencies {
	getCurrentSession(): AgentSessionState | undefined;
	updateSessionState(sessionId: string, patch: Partial<AgentSessionState>): void;
	getConfiguredTurnAgent(sessionId: string, model: AIModelId): Promise<SessionTurnPort>;
	getTurnAgent(sessionId: string): Promise<SessionTurnPort>;
	getSessionStore(): Pick<AgentSessionStore, 'read' | 'persistHistory' | 'writeMetadata'>;
	getReviewQueue(): Pick<ReviewQueueStore, 'syncSessionPendingChanges'>;
	refreshReviewState(): void;
	refreshSessionsList(): Promise<void>;
	hasCompletion(sessionId: string, submissionId: string): boolean;
	markCompletion(sessionId: string, submissionId: string): void;
	pruneOldSessions(): Promise<void>;
}

/** Coordinates one session's turn transitions without owning SDK or Durable Object state. */
export class AgentTurnCoordinator {
	private sessionMutationTails = new Map<string, Promise<void>>();

	constructor(private readonly dependencies: AgentTurnCoordinatorDependencies) {}

	async withSessionMutationLock<T>(sessionId: string, callback: () => Promise<T>): Promise<T> {
		const previousTail = this.sessionMutationTails.get(sessionId) ?? Promise.resolve();
		let resolveCurrentTail: (() => void) | undefined;
		const currentTail = new Promise<void>((resolve) => {
			resolveCurrentTail = resolve;
		});
		const nextTail = previousTail.catch(() => {}).then(() => currentTail);
		this.sessionMutationTails.set(sessionId, nextTail);

		await previousTail.catch(() => {});

		try {
			return await callback();
		} finally {
			resolveCurrentTail?.();
			if (this.sessionMutationTails.get(sessionId) === nextTail) {
				this.sessionMutationTails.delete(sessionId);
			}
		}
	}

	async submitMessage(
		sessionId: string,
		userMessage: ChatMessage,
		model: AIModelId,
		configuration: TurnExecutionConfiguration,
		current: AgentSessionState | undefined,
	): Promise<{ sessionId: string; queued: boolean; started: boolean }> {
		const shouldQueue = current?.sessionId === sessionId && current.status === 'running';
		const sessionAgent = await this.dependencies.getConfiguredTurnAgent(sessionId, model);
		const submission = await sessionAgent.submitTurn(userMessage, configuration);
		const liveMessages = current?.sessionId === sessionId ? current.messages : [];
		if (!liveMessages.some((message) => message.id === userMessage.id)) {
			this.dependencies.updateSessionState(sessionId, {
				status: 'running',
				statusText: shouldQueue ? current?.statusText : 'Thinking...',
				messages: [...liveMessages, userMessage],
				stopRequested: false,
				error: undefined,
			});
		}
		await this.dependencies.refreshSessionsList();
		return { sessionId, queued: shouldQueue, started: submission.accepted && !shouldQueue };
	}

	async removeQueuedMessage(sessionId: string, messageId: string, callerUserId?: string): Promise<{ removed: boolean }> {
		const current = this.dependencies.getCurrentSession();
		const messages = current?.sessionId === sessionId ? current.messages : [];
		const targetMessage = messages.find(
			(message) => message.id === messageId && message.role === 'user' && message.metadata?.request?.state === 'queued',
		);
		if (!targetMessage) return { removed: false };
		if (targetMessage.authorUserId && targetMessage.authorUserId !== callerUserId) {
			throw new Error('Not authorized to remove this queued message.');
		}

		const sessionAgent = await this.dependencies.getTurnAgent(sessionId);
		await sessionAgent.cancelSubmissionById(messageId);
		const latest = this.dependencies.getCurrentSession();
		if (latest?.sessionId === sessionId) {
			this.dependencies.updateSessionState(sessionId, {
				messages: latest.messages.filter((message) => message.id !== messageId),
			});
		}
		return { removed: true };
	}

	async startRun(
		sessionId: string,
		previousHistory: ChatMessage[],
		userMessage: ChatMessage,
		model: AIModelId,
		configuration: TurnExecutionConfiguration,
	): Promise<{ sessionId: string }> {
		const sessionAgent = await this.dependencies.getConfiguredTurnAgent(sessionId, model);
		await sessionAgent.replaceHistory(previousHistory);
		await sessionAgent.submitTurn(userMessage, configuration);
		this.dependencies.updateSessionState(sessionId, {
			status: 'running',
			statusText: 'Thinking...',
			messages: [userMessage],
			stopRequested: false,
			error: undefined,
		});
		return { sessionId };
	}

	async abortRun(sessionId: string): Promise<void> {
		this.dependencies.updateSessionState(sessionId, { stopRequested: true, statusText: 'Stopping...' });
		const sessionAgent = await this.dependencies.getTurnAgent(sessionId);
		await sessionAgent.cancelActiveSubmissions();
	}

	beginThinkTurn(sessionId: string, submissionId: string): void {
		const current = this.dependencies.getCurrentSession();
		if (current?.sessionId !== sessionId) return;
		this.dependencies.updateSessionState(sessionId, {
			status: 'running',
			statusText: 'Thinking...',
			messages: current.messages.map((message) => {
				if (message.id !== submissionId || message.role !== 'user' || !message.metadata?.request) return message;
				return {
					...message,
					metadata: { ...message.metadata, request: { ...message.metadata.request, state: 'committed' } },
				};
			}),
		});
	}

	async completeThinkTurn(
		sessionId: string,
		submissionId: string,
		history: ChatMessage[],
		status: 'completed' | 'error' | 'aborted',
		error?: string,
		activeSubmissions: ActiveThinkSubmission[] = [],
	): Promise<void> {
		if (this.dependencies.hasCompletion(sessionId, submissionId)) return;

		const sessionStore = this.dependencies.getSessionStore();
		const persistedSession = await sessionStore.read(sessionId);
		const persistedHistory = persistedSession?.history ?? [];
		const current = this.dependencies.getCurrentSession();
		const liveHistory = current?.sessionId === sessionId ? current.messages : [];
		const mergedHistory = mergeThinkHistory(history, [...persistedHistory, ...liveHistory]);
		const hasActiveSubmission = activeSubmissions.length > 0;
		await sessionStore.persistHistory(sessionId, mergedHistory, false);
		sessionStore.writeMetadata(sessionId, {
			status: hasActiveSubmission ? 'running' : status === 'completed' ? 'completed' : status,
			errorMessage: hasActiveSubmission ? undefined : error,
			stopRequested: false,
		});
		const latest = this.dependencies.getCurrentSession();
		if (latest?.sessionId === sessionId) {
			const activeMessages = getActiveThinkMessages(latest.messages, activeSubmissions);
			this.dependencies.getReviewQueue().syncSessionPendingChanges(sessionId, latest.pendingChanges);
			this.dependencies.refreshReviewState();
			this.dependencies.updateSessionState(sessionId, {
				status: hasActiveSubmission ? 'running' : status === 'completed' ? 'completed' : status,
				statusText: hasActiveSubmission ? 'Thinking...' : undefined,
				error: hasActiveSubmission ? undefined : error ? { message: error } : undefined,
				messages: activeMessages,
				historyVersion: latest.historyVersion + 1,
				stopRequested: false,
				toolMetadata: {},
				toolErrors: {},
				subAgentActivities: {},
			});
		}
		await this.dependencies.refreshSessionsList();
		this.dependencies.markCompletion(sessionId, submissionId);
		await this.dependencies.pruneOldSessions().catch((pruneError) => {
			console.error('[AgentRunner] Session pruning failed:', pruneError);
		});
	}
}
