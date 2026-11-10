import { Buffer } from 'node:buffer';

import { getWorkspace } from '@cloudflare/computer';
import { Think } from '@cloudflare/think';
import { getCurrentAgent } from 'agents';
import { parseProtocolMessage } from 'agents/chat';
import { z } from 'zod';

import { agentMessageText, initialChatState } from '@shared/agent-chat';
import { mergeCommandOutput } from '@shared/command-output';
import { AGENT_SYSTEM_PROMPT, DEFAULT_AI_MODEL, getModelLimits } from '@shared/constants';

import { ProjectAgent } from './project-agent';
import { filesystemNamespace } from '../lib/durable-object-namespaces';
import { runWithProjectStub } from '../lib/project-fs';
import { toDurableObjectId } from '../lib/project-id';
import { AgentLogger } from '../services/agent/agent-logger';
import { createSendEventFunction, drainEventQueue, toolErrorEvents } from '../services/agent/event-helpers';
import { finalizeAgentChanges } from '../services/agent/finalize-changes';
import {
	configureHarnessSession,
	readHarnessHistoryPage,
	HARNESS_MAX_RETRIES,
	harnessContextGuard,
	withHarnessContextBudget,
} from '../services/agent/harness-session';
import { accumulatePendingChange } from '../services/agent/pending-changes';
import { addFileToSnapshot, initSnapshot } from '../services/agent/snapshot-manager';
import { buildRuntimePromptAdditions, readAgentsContext } from '../services/agent/system-prompt-builder';
import { estimateMessagesTokens } from '../services/agent/token-estimate';
import { ToolFailureGuard, toolOutputError } from '../services/agent/tool-failure-guard';
import { createServerTools } from '../services/agent/tools';
import { createAdapter } from '../services/agent/workers-ai';

import type { AgentDebugLog } from '../services/agent/agent-logger';
import type { PendingAgentFinalization } from '../services/agent/finalize-changes';
import type { ToolFailureState } from '../services/agent/tool-failure-guard';
import type { FileChange } from '../services/agent/types';
import type {
	Session,
	ThinkSubmissionInspection,
	TurnContext,
	TurnConfig,
	StepContext,
	PrepareStepContext,
	ChatRecoveryContext,
	ChatResponseResult,
} from '@cloudflare/think';
import type { AgentMessage, ChatConfiguration, ChatState } from '@shared/agent-chat';
import type { StreamEvent } from '@shared/agent-state';
import type { PendingFileChange, AgentMode } from '@shared/types';
import type { Connection, ConnectionContext } from 'agents';
import type { ContextConfig } from 'agents/context';
import type { StopCondition, ToolSet } from 'ai';

export const shouldWaitForUser: StopCondition<ToolSet> = ({ steps }) =>
	steps.at(-1)?.toolResults.some((result) => result.toolName === 'user_question') ?? false;

interface SessionTurnState extends ChatState {
	revision: number;
}
interface ChatExecutionState {
	activeRequestId?: string;
	activeUserId?: string;
	failureState?: ToolFailureState;
	activeDebugLog?: AgentDebugLog;
	activeSnapshot?: { id: string; directory: string; savedPaths: string[] };
	pendingChanges: Record<string, PendingFileChange>;
	finalizations: Record<string, PendingAgentFinalization>;
	webTurn?: {
		operationId: string;
		requestId: string;
		userId: string;
		changes: Record<string, PendingFileChange>;
		debugLog?: AgentDebugLog;
		snapshot?: PendingAgentFinalization['snapshot'];
	};
}

/** One authoritative Think conversation, directly observed by its browser clients. */
export class SessionTurnAgent extends Think<Env, SessionTurnState> {
	initialState: SessionTurnState = { ...initialChatState(), revision: 0 };
	private configureChatTransport(): void {
		const nativeOnMessage = this.onMessage.bind(this);
		this.onMessage = async (connection, message) => {
			const event = typeof message === 'string' ? parseProtocolMessage(message) : undefined;
			if (event?.type === 'chat-request') {
				if (this.ctx.storage.kv.get('admissions-closed')) {
					connection.close(1008, 'Session is being deleted');
					return;
				}
				// The SDK owns regeneration and transport; application submissions enter the durable ledger through Hono.
				const body = z
					.object({
						trigger: z.literal('regenerate-message'),
						messages: z
							.array(z.object({ id: z.string() }))
							.min(1)
							.max(1000),
					})
					.safeParse(parseChatRequestBody(event.init.body));
				if (!body.success) {
					connection.close(1008, 'Use the submission endpoint');
					return;
				}
				const messages = [];
				for (const reference of body.data.messages) {
					const stored = await this.session.getMessage(reference.id);
					if (!stored) {
						connection.close(1008, 'Unknown transcript message');
						return;
					}
					messages.push(stored);
				}
				// Reuse server-authenticated content and author metadata, including on older branches.
				const request = z
					.object({ type: z.string(), id: z.string(), init: z.record(z.string(), z.unknown()) })
					.parse(JSON.parse(message.toString()));
				request.init.body = JSON.stringify({ trigger: body.data.trigger, messages });
				// Validation reads can yield to deletion; check again immediately before SDK admission.
				if (this.ctx.storage.kv.get('admissions-closed')) {
					connection.close(1008, 'Session is being deleted');
					return;
				}
				const handling = Promise.resolve(nativeOnMessage(connection, JSON.stringify(request)));
				this.nativeRequests.add(handling);
				try {
					await handling;
				} finally {
					this.nativeRequests.delete(handling);
				}
				return;
			}
			if (event && ['clear', 'messages', 'tool-result', 'tool-approval'].includes(event.type)) {
				connection.close(1008, 'Unsupported chat operation');
				return;
			}
			return nativeOnMessage(connection, message);
		};
	}

	private executionState?: ChatExecutionState;
	private get execution(): ChatExecutionState {
		return (this.executionState ??= this.ctx.storage.kv.get<ChatExecutionState>('execution') ?? { pendingChanges: {}, finalizations: {} });
	}
	override maxSteps = 100;
	override includeMcpTools = false;
	override mediaEviction = false;
	override chatRecovery = { maxInterruptedAttempts: 5, maxAttempts: 2 };
	override contextOverflow = harnessContextGuard(DEFAULT_AI_MODEL);
	override workspace = getWorkspace({ __getWorkspaceStub: () => this.filesystem.getAgentWorkspace(this.configuration.sessionId) });
	private events: StreamEvent[] = [];
	private changes: FileChange[] = [];
	private controller = new AbortController();
	private failureGuard?: ToolFailureGuard;
	private logger?: AgentLogger;
	private finalizationPromise?: Promise<void>;
	private changePreparation?: Promise<void>;
	private admissionTail = Promise.resolve();
	private readonly nativeRequests = new Set<Promise<void>>();
	private outputEvents = new Map<string, Extract<StreamEvent, { type: 'tool-output' }>>();
	private outputTimer?: ReturnType<typeof setTimeout>;
	private eventFlush = Promise.resolve();

	override validateStateChange(_state: SessionTurnState, source: Connection | 'server'): void {
		if (source !== 'server') throw new Error('Chat state is server-owned');
	}

	override getTools(): ToolSet {
		return {};
	}
	override getModel() {
		return this.state.configuration?.model ?? DEFAULT_AI_MODEL;
	}
	override getSystemPrompt(): string {
		return AGENT_SYSTEM_PROMPT;
	}
	override configureSession(session: Session): Session {
		return configureHarnessSession(session, () => ({ ...this.state.configuration, abortSignal: this.controller.signal }));
	}
	override configureContext(): ContextConfig[] {
		return [
			{
				label: 'memory',
				description: 'Shared project facts.',
				maxTokens: 2000,
				whenChanged: 'remind',
				provider: {
					get: async () => {
						const parent = await this.parentAgent(ProjectAgent);
						return parent.readSharedMemory();
					},
					set: async (content: string) => {
						const parent = await this.parentAgent(ProjectAgent);
						return parent.writeSharedMemory(content);
					},
				},
			},
			{
				label: 'artifacts',
				description: 'Search plans, todos, diagnostics and delegated reports.',
				provider: {
					get: async () => '',
					search: async (query) => {
						const parent = await this.parentAgent(ProjectAgent);
						return parent.searchArtifacts(query);
					},
				},
			},
		];
	}
	override async onStart(): Promise<void> {
		await super.onStart();
		this.configureChatTransport();
		if (this.state.configuration) {
			await this.refreshSubmissionState();
			if (Object.keys(this.execution.finalizations).length > 0) await this.queue('flushFinalizations', {});
		}
	}
	override async onConnect(connection: Connection, context: ConnectionContext): Promise<void> {
		const userId = context.request.headers.get('x-worker-ide-user-id');
		if (!userId) throw new Error('Authentication required');
		connection.setState({ userId });
		await super.onConnect(connection, context);
	}

	override async onBeforeSubAgent(): Promise<Response> {
		return new Response('Session not found', { status: 404 });
	}

	async configureSessionTurn(configuration: ChatConfiguration): Promise<void> {
		if (this.state.configuration) return;
		this.update({ configuration });
		await this.filesystem.registerComputerSession(configuration.sessionId, configuration.mode, configuration.requestOriginContext);
	}
	async updateSettings(settings: Pick<ChatConfiguration, 'mode' | 'model'>): Promise<void> {
		await this.withAdmission(async () => {
			if (
				this.execution.webTurn ||
				Object.keys(this.execution.finalizations).length > 0 ||
				(await this.hasPendingSubmissions()) ||
				!(await this.waitUntilStable({ timeout: 1 }))
			)
				throw new Error('Stop or finish the queued turns before changing settings.');
			this.update({ configuration: { ...this.configuration, ...settings } });
		});
	}
	async submitTurn(message: AgentMessage) {
		return this.withAdmission(() => this.admitMessage(message));
	}
	async closeAdmissions(): Promise<void> {
		this.ctx.storage.kv.put('admissions-closed', true);
		// An already admitted submission must finish persisting before cancellation enumerates the ledger.
		await this.admissionTail;
	}
	private async admitMessage(message: AgentMessage) {
		if (this.state.stopRequested) throw new Error('Wait until the agent stops before submitting another message.');
		message = { ...message, metadata: { ...message.metadata, model: this.configuration.model, mode: this.configuration.mode } };
		const result = await this.runTurn({
			mode: 'submit',
			channel: 'web',
			input: message,
			submissionId: message.id,
			idempotencyKey: message.id,
			metadata: {
				initiatorUserId: message.metadata?.authorUserId,
				preview: agentMessageText(message).slice(0, 200),
				model: this.configuration.model,
				mode: this.configuration.mode,
			},
		});
		await this.refreshSubmissionState();
		return { accepted: result.accepted, submissionId: result.submissionId, status: result.status };
	}
	async cancelSubmissionById(id: string, userId: string) {
		const pending = this.state.queuedMessages.find((message) => message.id === id);
		if (!pending) throw new Error('Queued message not found');
		if (pending.authorUserId !== userId) throw new Error('Only the author can remove a queued message');
		const result = await this.cancelSubmission(id, 'Cancelled by user');
		await this.refreshSubmissionState();
		return result;
	}
	async cancelActiveSubmissions(): Promise<void> {
		this.update({ stopRequested: true, statusText: 'Stopping…' });
		this.controller.abort();
		if (this.execution.webTurn) this.cancelChat(this.execution.webTurn.requestId, 'Cancelled by user');
		this.cancelAllChats();
		const submissions = await this.listSubmissions({ status: ['pending', 'running'] });
		for (const submission of submissions.filter((item) => item.status === 'pending'))
			await this.cancelSubmission(submission.submissionId, 'Cancelled by user');
		for (const submission of submissions.filter((item) => item.status === 'running')) {
			this.ctx.waitUntil(this.filesystem.cancelComputerSessionExecutions(this.configuration.sessionId, submission.submissionId));
			await this.cancelSubmission(submission.submissionId, 'Cancelled by user');
		}
		if (submissions.length > 0) this.update({ status: 'aborted' });
		await this.refreshSubmissionState();
	}
	async waitForCompletion(): Promise<void> {
		// A native request may still be entering the SDK queue when cancellation runs.
		if (!(await this.waitUntilStable({ timeout: 30_000 })) || this.nativeRequests.size > 0)
			throw new Error('The agent is still stopping. Try again once its work has settled.');
	}

	override async onChatRecovery(context: ChatRecoveryContext) {
		if (this.ctx.storage.kv.get('admissions-closed')) return { continue: false };
		if (!this.state.activeSubmissionId) return { continue: false };
		const executions = await this.filesystem.getComputerExecutions(this.configuration.sessionId);
		const unsafe = executions.some((execution) => ['starting', 'running', 'synchronization-pending'].includes(execution.status));
		if (unsafe || this.state.stopRequested) return { continue: false };
		if (!this.ctx.storage.kv.get(`mutation:${this.state.activeSubmissionId}`)) return { continue: true };
		// Resume inference after persisted results and the filesystem's durable FIFO barrier.
		const tools = (context.partialParts ?? []).filter((part) => part.type === 'dynamic-tool' || part.type.startsWith('tool-'));
		if (
			context.recoveryKind !== 'continue' ||
			tools.length === 0 ||
			tools.some((part) => !('state' in part) || !['output-available', 'output-error'].includes(String(part.state)))
		)
			return { continue: false };
		try {
			await this.filesystem.settleAgentTurn(this.configuration.sessionId);
			return { continue: true };
		} catch {
			return { continue: false };
		}
	}
	override async beforeTurn(context: TurnContext): Promise<TurnConfig> {
		context.abortSignal?.throwIfAborted();
		await this.prepareFinalizationChanges();
		context.abortSignal?.throwIfAborted();
		this.assertAdmissionsOpen();
		const configuration = this.configuration;
		if (context.trigger === 'ws-chat') {
			const identity = z.object({ userId: z.string() }).parse(getCurrentAgent().connection?.state);
			if (!context.requestId) throw new Error('Missing request identity');
			this.initializeTurn(context.requestId, identity.userId);
			this.update({
				status: 'running',
				webTurn: {
					operationId: context.requestId,
					requestId: context.requestId,
					userId: identity.userId,
					changes: this.execution.pendingChanges,
				},
			});
		}
		const webTurn = this.execution.webTurn;
		if (webTurn && webTurn.operationId === this.state.activeSubmissionId && context.requestId)
			this.update({ webTurn: { ...webTurn, requestId: context.requestId } });
		const submissionId = this.state.activeSubmissionId;
		if (!submissionId) throw new Error('Missing durable submission identity');
		this.update({ activeRequestId: context.requestId });
		this.controller = new AbortController();
		const controller = this.controller;
		context.abortSignal?.throwIfAborted();
		context.abortSignal?.addEventListener('abort', () => controller.abort(), { once: true });
		this.events = [];
		this.changes = [];
		this.logger = new AgentLogger(
			configuration.sessionId,
			configuration.projectId,
			configuration.model,
			configuration.mode,
			this.execution.activeDebugLog,
		);
		this.logger.info('agent_loop', context.continuation ? 'resumed' : 'started', { submissionId });
		this.update({ activeDebugLog: this.logger.toJSON() });
		this.failureGuard = new ToolFailureGuard(
			() => this.execution.failureState ?? { submissionId, count: 0, seen: [] },
			(failureState) => {
				this.update({ failureState });
				if (failureState.message) this.controller.abort(new Error(failureState.message));
			},
		);
		await this.filesystem.beginComputerSessionTurn(
			configuration.sessionId,
			submissionId,
			configuration.mode,
			configuration.requestOriginContext,
		);
		const sendEvent = createSendEventFunction(this.events, { current: undefined }, this.controller.signal);
		if (configuration.mode === 'code' && !this.execution.activeSnapshot) {
			const snapshot = await runWithProjectStub(
				this.filesystem,
				() => initSnapshot('/project', configuration.sessionId, context.messages, sendEvent),
				'/project',
				configuration.sessionId,
			);
			this.update({ activeSnapshot: { id: snapshot.id, directory: snapshot.directory, savedPaths: [] } });
			if (this.execution.webTurn?.operationId === submissionId)
				this.update({ webTurn: { ...this.execution.webTurn, snapshot: this.execution.activeSnapshot } });
		}
		const instructions = await runWithProjectStub(this.filesystem, async () =>
			buildSessionTurnInstructions(configuration.mode, await readAgentsContext('/project'), context.system),
		);
		const parent = await this.parentAgent(ProjectAgent);
		const tools = await createServerTools(
			sendEvent,
			{
				projectRoot: '/project',
				...configuration,
				userId: this.execution.webTurn?.userId ?? this.execution.activeUserId,
				submissionId,
				abortSignal: this.controller.signal,
				beforeMutation: () => this.recordMutation(submissionId),
				callMcpTool: async (serverId, name, arguments_) => {
					const result = await parent.callMcpTool(serverId, name, arguments_);
					if (result.isError) throw new Error(result.content);
					return result.content;
				},
				listMcpTools: () => parent.listMcpTools(),
				ctx: this.ctx,
				loader: this.env.LOADER,
				browser: this.env.BROWSER,
				agentReference: this,
				fsStub: this.filesystem,
				failureGuard: this.failureGuard,
				onToolOutput: async (event) => this.bufferOutput(event),
				indexArtifact: (entry) => parent.indexArtifact(entry),
				readCompletionReviewContext: async () => ({
					messages: await this.getMessages(),
					changedPaths: this.execution.activeSnapshot?.savedPaths ?? [],
					todos: [],
					observations: [],
					revision: 0,
					incomplete: context.continuation,
				}),
			},
			this.changes,
			configuration.mode,
			this.logger,
		);
		this.contextOverflow = harnessContextGuard(configuration.model);
		return {
			model: withHarnessContextBudget(
				createAdapter(configuration.model, { ...configuration, generationType: 'agent' }),
				configuration.model,
			),
			instructions,
			tools,
			activeTools: [...Object.keys(tools), ...Object.keys(await this.context.tools())],
			maxSteps: this.maxSteps,
			stopWhen: shouldWaitForUser,
			maxRetries: HARNESS_MAX_RETRIES,
			maxOutputTokens: getModelLimits(configuration.model).maxOutput,
			messageMetadata: () => ({
				createdAt: Date.now(),
				submissionId,
				snapshotId: this.execution.activeSnapshot?.id,
				model: configuration.model,
				mode: configuration.mode,
			}),
		};
	}
	override async beforeStep(context: PrepareStepContext): Promise<void> {
		if (this.activeTurn?.requestId && this.activeTurn.requestId !== this.execution.activeRequestId) return;
		this.failureGuard?.assertHealthy();
		this.update({ contextTokensUsed: estimateMessagesTokens(context.messages) });
		await this.flushToolEvents();
	}
	override async onStepEnd(context: StepContext): Promise<void> {
		if (this.activeTurn?.requestId && this.activeTurn.requestId !== this.execution.activeRequestId) return;
		for (const result of context.toolResults)
			this.failureGuard?.record({
				id: result.toolCallId,
				toolName: result.toolName,
				input: result.input,
				error: toolOutputError(result.output),
			});
		this.events.push(...toolErrorEvents(context.content));
		this.logger?.recordTokenUsage(context.usage.inputTokens ?? 0, context.usage.outputTokens ?? 0);
		this.logger?.info('llm', 'response', { text: context.text, finishReason: context.finishReason });
		await this.flushToolEvents();
		if (this.logger) this.update({ activeDebugLog: this.logger.toJSON() });
		if (this.execution.webTurn)
			this.update({
				webTurn: {
					...this.execution.webTurn,
					changes: this.execution.pendingChanges,
					snapshot: this.execution.activeSnapshot,
					debugLog: this.logger?.toJSON(),
				},
			});
		this.failureGuard?.assertHealthy();
	}
	override async onChatResponse(result: ChatResponseResult): Promise<void> {
		const turn = this.execution.webTurn;
		if (!turn || turn.requestId !== result.requestId) return;
		const status = this.state.stopRequested ? 'aborted' : result.status;
		const ownsStatus = this.state.activeSubmissionId === turn.operationId;
		this.update({
			webTurn: this.execution.webTurn?.operationId === turn.operationId ? undefined : this.execution.webTurn,
			...(ownsStatus ? { status, statusText: undefined, error: result.error, stopRequested: false } : {}),
			activeSubmissionId: this.state.activeSubmissionId === turn.operationId ? undefined : this.state.activeSubmissionId,
			finalizations: {
				...this.execution.finalizations,
				[turn.operationId]: {
					changesPrepared: false,
					submissionId: turn.operationId,
					status,
					initiatorUserId: turn.userId,
					changes: turn.changes,
					snapshot: turn.snapshot,
					debugLog: finishDebugLog(turn.debugLog ?? this.execution.activeDebugLog, status, result.error),
				},
			},
		});
		await this.queue('flushFinalizations', {});
		await this.refreshSubmissionState();
	}
	override async onSubmissionStatus(submission: ThinkSubmissionInspection): Promise<void> {
		if (submission.status === 'running') {
			this.initializeTurn(
				submission.submissionId,
				typeof submission.metadata?.initiatorUserId === 'string' ? submission.metadata.initiatorUserId : undefined,
			);
			await this.refreshSubmissionState();
			return;
		}
		if (submission.status === 'pending') {
			await this.refreshSubmissionState();
			return;
		}
		if (this.ctx.storage.kv.get(`finalized:${submission.submissionId}`)) {
			await this.refreshSubmissionState();
			return;
		}
		if (this.execution.finalizations[submission.submissionId]) {
			await this.queue('flushFinalizations', {});
			await this.refreshSubmissionState();
			return;
		}
		const ownsTurn =
			this.state.activeSubmissionId === submission.submissionId || this.execution.failureState?.submissionId === submission.submissionId;
		if (ownsTurn) await this.flushToolEvents();
		const terminal = getTerminalSubmissionResult(submission);
		const metadata = submission.metadata;
		const finalization: PendingAgentFinalization = {
			changesPrepared: false,
			submissionId: submission.submissionId,
			...terminal,
			initiatorUserId: typeof metadata?.initiatorUserId === 'string' ? metadata.initiatorUserId : undefined,
			changes: ownsTurn ? this.execution.pendingChanges : {},
			snapshot: ownsTurn ? this.execution.activeSnapshot : undefined,
			debugLog: ownsTurn ? finishDebugLog(this.execution.activeDebugLog, terminal.status, terminal.error) : undefined,
		};
		this.update({
			...(ownsTurn ? { status: terminal.status, error: terminal.error, stopRequested: false, statusText: undefined } : {}),
			activeSubmissionId: this.state.activeSubmissionId === submission.submissionId ? undefined : this.state.activeSubmissionId,
			finalizations: { ...this.execution.finalizations, [submission.submissionId]: finalization },
		});
		await this.queue('flushFinalizations', {});
		await this.refreshSubmissionState();
	}

	async flushFinalizations(): Promise<void> {
		if (this.finalizationPromise) return this.finalizationPromise;
		this.finalizationPromise = this.deliverFinalizations().finally(() => {
			this.finalizationPromise = undefined;
		});
		return this.finalizationPromise;
	}
	private async deliverFinalizations(): Promise<void> {
		await this.prepareFinalizationChanges();
		const parent = await this.parentAgent(ProjectAgent);
		for (const finalization of Object.values(this.execution.finalizations)) {
			if (!finalization.changesPrepared) continue;
			// Give this derived directory update its own monotonic revision.
			this.update({ status: this.state.status });
			if (finalization.debugLog) {
				const log = finalization.debugLog;
				const logger = new AgentLogger(log.sessionId, log.projectId, log.model, log.mode, log);
				await runWithProjectStub(this.filesystem, () => logger.flush('/project', log));
				if (!logger.isFlushed) throw new Error('Agent debug log was not saved');
				this.update({ debugLogId: log.id });
			}
			await parent.completeSessionOperation({
				...finalization,
				sessionId: this.configuration.sessionId,
				summary: {
					status: this.state.status,
					revision: this.state.revision,
					finalizing: Object.keys(this.execution.finalizations).length > 1,
				},
			});

			const finalizations = { ...this.execution.finalizations };
			delete finalizations[finalization.submissionId];
			this.ctx.storage.kv.put(`finalized:${finalization.submissionId}`, true);
			this.ctx.storage.kv.delete(`mutation:${finalization.submissionId}`);
			this.update({ finalizations });
		}
	}
	private prepareFinalizationChanges(): Promise<void> {
		this.changePreparation ??= this.prepareChanges().finally(() => {
			this.changePreparation = undefined;
		});
		return this.changePreparation;
	}
	private async prepareChanges(): Promise<void> {
		for (const pending of Object.values(this.execution.finalizations)) {
			if (pending.changesPrepared) continue;

			const prepared = await finalizeAgentChanges(this.filesystem, this.configuration, pending, this.checkpointFinalization.bind(this));
			this.checkpointFinalization({ ...prepared, changesPrepared: true });
		}
	}
	private checkpointFinalization(updated: PendingAgentFinalization): void {
		this.update({ finalizations: { ...this.execution.finalizations, [updated.submissionId]: updated } });
	}
	private async withAdmission<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.admissionTail;
		const release = Promise.withResolvers<void>();
		this.admissionTail = release.promise;
		await previous;
		try {
			this.assertAdmissionsOpen();
			return await operation();
		} finally {
			release.resolve();
		}
	}
	private assertAdmissionsOpen(): void {
		if (this.ctx.storage.kv.get('admissions-closed')) throw new Error('Session is being deleted');
	}
	private initializeTurn(submissionId: string, userId?: string): void {
		// The operation identity survives inference recovery; a new branch or submission starts fresh.
		if (this.execution.failureState?.submissionId === submissionId) return;
		this.update({
			activeSubmissionId: submissionId,
			activeUserId: userId,
			activeSnapshot: undefined,
			pendingChanges: {},
			activeDebugLog: undefined,
			failureState: { submissionId, count: 0, seen: [] },
			toolMetadata: {},
			toolErrors: {},
			error: undefined,
		});
	}
	private async hasPendingSubmissions(): Promise<boolean> {
		const submissions = await this.listSubmissions({ status: ['pending', 'running'] });
		return submissions.length > 0;
	}
	private async refreshSubmissionState(): Promise<void> {
		if (!this.state.configuration) return;
		const submissions = await this.listSubmissions({ status: ['pending', 'running'] });
		const running = submissions.find((submission) => submission.status === 'running');
		const queuedMessages = submissions
			.filter((submission) => submission.status === 'pending')
			.map((submission) => ({
				id: submission.submissionId,
				text: typeof submission.metadata?.preview === 'string' ? submission.metadata.preview : 'Queued message',
				authorUserId: typeof submission.metadata?.initiatorUserId === 'string' ? submission.metadata.initiatorUserId : undefined,
			}));
		this.update({
			queuedMessages,
			status: submissions.length > 0 || this.execution.webTurn ? 'running' : this.state.status === 'running' ? 'idle' : this.state.status,
			activeSubmissionId: running?.submissionId ?? this.execution.webTurn?.operationId,
			stopRequested: submissions.length > 0 || this.execution.webTurn ? this.state.stopRequested : false,
		});
		const parent = await this.parentAgent(ProjectAgent);
		await parent.updateSessionSummary(this.configuration.sessionId, {
			status: this.state.status,
			revision: this.state.revision,
			finalizing: this.state.finalizing,
		});
	}
	async searchHistory(query: string) {
		const results = await this.session.search(query, { limit: 10 });
		return results.map((result) => ({ messageId: result.id, content: result.content }));
	}
	async readHistory(before?: string, leafId?: string): Promise<string> {
		return JSON.stringify(await readHarnessHistoryPage(this.session, before, leafId));
	}
	async branches(messageId: string) {
		const branches = await this.session.getBranches(messageId);
		return branches.map((message) => ({ id: message.id, role: message.role }));
	}
	recordMutation(submissionId: string): void {
		if (this.state.activeSubmissionId !== submissionId || this.state.stopRequested) throw new Error('This turn is no longer active');
		this.ctx.storage.kv.put(`mutation:${submissionId}`, true);
	}
	async listProjectMcpTools() {
		const parent = await this.parentAgent(ProjectAgent);
		return parent.listMcpTools();
	}
	async callProjectMcpTool(serverId: string, name: string, arguments_: Record<string, unknown>): Promise<string> {
		const parent = await this.parentAgent(ProjectAgent);
		const result = await parent.callMcpTool(serverId, name, arguments_);
		if (result.isError) throw new Error(result.content);
		return result.content;
	}
	async receiveSubAgentEvents(events: StreamEvent[], submissionId: string): Promise<void> {
		if (submissionId !== this.state.activeSubmissionId) return;
		this.events.push(...events);
		await this.flushToolEvents();
	}
	private bufferOutput(event: Extract<StreamEvent, { type: 'tool-output' }>): void {
		if (event.submissionId !== this.state.activeSubmissionId || this.controller.signal.aborted) return;
		this.outputEvents.set(`${event.toolCallId}:${event.output.executionId}`, event);
		this.outputTimer ??= setTimeout(() => {
			this.outputTimer = undefined;
			this.ctx.waitUntil(this.flushToolEvents());
		}, 100);
	}
	private flushToolEvents(): Promise<void> {
		const flush = this.eventFlush.then(() => this.applyToolEvents());
		this.eventFlush = flush.catch(() => {});
		return flush;
	}
	private async applyToolEvents(): Promise<void> {
		clearTimeout(this.outputTimer);
		this.outputTimer = undefined;
		const events = [...drainEventQueue(this.events), ...this.outputEvents.values()];
		this.outputEvents.clear();
		if (events.length === 0 || !this.state.configuration) return;
		const toolMetadata = { ...this.state.toolMetadata };
		const toolErrors = { ...this.state.toolErrors };
		const changes = new Map(Object.entries(this.execution.pendingChanges));
		let statusText = this.state.statusText;
		for (const event of events) {
			if (event.type === 'status') statusText = event.message;
			if (event.type === 'tool-result')
				toolMetadata[event.toolCallId] = { ...event, commandOutput: toolMetadata[event.toolCallId]?.commandOutput };
			if (event.type === 'tool-error') toolErrors[event.toolCallId] = { ...event };
			if (event.type === 'tool-output') {
				const previous = toolMetadata[event.toolCallId];
				toolMetadata[event.toolCallId] = {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					title: previous?.title ?? event.toolName,
					metadata: previous?.metadata ?? {},
					commandOutput: mergeCommandOutput(previous?.commandOutput, event.output),
				};
			}
			if (event.type !== 'file-changed' || event.action === 'move') continue;
			const action = event.action;
			const snapshot = this.execution.activeSnapshot;
			if (snapshot) {
				const context = { ...snapshot, savedPaths: new Set(snapshot.savedPaths) };
				await runWithProjectStub(
					this.filesystem,
					() =>
						addFileToSnapshot(context, {
							path: event.path,
							action,
							isBinary: event.isBinary ?? false,
							entryType: event.entryType,
							beforeEntryType: event.beforeEntryType,
							beforeContent: event.beforeBytes ? new Uint8Array(Buffer.from(event.beforeBytes, 'base64')) : event.beforeContent,
							afterContent: event.afterBytes ? new Uint8Array(Buffer.from(event.afterBytes, 'base64')) : event.afterContent,
						}),
					'/project',
					this.configuration.sessionId,
				);
				this.update({ activeSnapshot: { ...snapshot, savedPaths: [...context.savedPaths] } });
			}
			accumulatePendingChange(changes, { ...event, sessionId: this.configuration.sessionId, snapshotId: snapshot?.id });
		}
		this.update({ toolMetadata, toolErrors, pendingChanges: Object.fromEntries(changes), statusText });
	}
	private update(patch: Partial<SessionTurnState & ChatExecutionState>): void {
		const {
			activeRequestId,
			activeUserId,
			failureState,
			activeDebugLog,
			activeSnapshot,
			pendingChanges,
			finalizations,
			webTurn,
			...publicPatch
		} = patch;
		const executionPatch: Partial<ChatExecutionState> = {
			...('activeRequestId' in patch ? { activeRequestId } : {}),
			...('activeUserId' in patch ? { activeUserId } : {}),
			...('failureState' in patch ? { failureState } : {}),
			...('activeDebugLog' in patch ? { activeDebugLog } : {}),
			...('activeSnapshot' in patch ? { activeSnapshot } : {}),
			...('pendingChanges' in patch ? { pendingChanges } : {}),
			...('finalizations' in patch ? { finalizations } : {}),
			...('webTurn' in patch ? { webTurn } : {}),
		};
		if (Object.keys(executionPatch).length > 0) {
			this.executionState = { ...this.execution, ...executionPatch };
			this.ctx.storage.kv.put('execution', this.executionState);
		}
		const finalizing = Object.keys(this.execution.finalizations).length > 0;
		if (Object.keys(publicPatch).length > 0 || this.state.finalizing !== finalizing)
			this.setState({ ...this.state, ...publicPatch, finalizing, revision: this.state.revision + 1 });
	}
	private get configuration(): ChatConfiguration {
		if (!this.state.configuration) throw new Error('Session is not configured');
		return this.state.configuration;
	}
	private get filesystem() {
		return filesystemNamespace.get(toDurableObjectId(filesystemNamespace, this.configuration.projectId));
	}
}

export function getTerminalSubmissionResult(submission: ThinkSubmissionInspection): {
	status: 'completed' | 'error' | 'aborted';
	error?: string;
} {
	if (submission.status === 'completed') return { status: 'completed' };
	if (submission.status === 'aborted' || submission.status === 'skipped') return { status: 'aborted' };
	return { status: 'error', error: submission.error ?? 'The agent turn failed.' };
}

function parseChatRequestBody(body: unknown): unknown {
	if (typeof body !== 'string') return;
	try {
		const parsed: unknown = JSON.parse(body);
		return parsed;
	} catch {
		return;
	}
}

export async function buildSessionTurnInstructions(mode: AgentMode, agentsContext?: string, system = AGENT_SYSTEM_PROMPT): Promise<string> {
	return `${system}\n\n${await buildRuntimePromptAdditions('/project', mode)}${agentsContext ? `\n\n## Project Guidelines (from AGENTS.md)\n${agentsContext}` : ''}`;
}

function finishDebugLog(
	log: AgentDebugLog | undefined,
	status: 'completed' | 'error' | 'aborted',
	error?: string,
): AgentDebugLog | undefined {
	if (!log) return;
	const logger = new AgentLogger(log.sessionId, log.projectId, log.model, log.mode, log);
	if (status === 'aborted') logger.markAborted();
	if (error) logger.error('agent_loop', status, { message: error });
	logger.info('agent_loop', 'finished', { status });
	return logger.toJSON();
}
