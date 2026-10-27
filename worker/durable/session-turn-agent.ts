import { Buffer } from 'node:buffer';

import { Think } from '@cloudflare/think';

import { AGENT_SYSTEM_PROMPT, DEFAULT_AI_MODEL, MCP_SERVERS, getModelLimits } from '@shared/constants';
import { aiModelSchema } from '@shared/validation';

import { AgentRunner } from './agent-runner';
import { SessionEventBatcher } from './session-event-batcher';
import { clearSnapshotFromMessages } from './session-history';
import { filesystemNamespace } from '../lib/durable-object-namespaces';
import { runWithProjectStub } from '../lib/project-fs';
import { toDurableObjectId } from '../lib/project-id';
import { AgentLogger } from '../services/agent/agent-logger';
import { estimateMessagesTokens } from '../services/agent/context-pruner';
import { createSendEventFunction, drainEventQueue, toolErrorEvents } from '../services/agent/event-helpers';
import {
	configureHarnessSession,
	HARNESS_MAX_RETRIES,
	harnessContextGuard,
	withHarnessContextBudget,
	readHarnessTranscript,
} from '../services/agent/harness-session';
import { registerConfiguredMcpServers } from '../services/agent/mcp';
import { isRequestOriginContext, type RequestOriginContext } from '../services/agent/request-origin-context';
import { addFileToSnapshot, deleteDirectoryRecursive, initSnapshot } from '../services/agent/snapshot-manager';
import { buildRuntimePromptAdditions, readAgentsContext } from '../services/agent/system-prompt-builder';
import { chatMessageToUiMessage, uiMessagesToChatMessages, userMessageToUiMessage } from '../services/agent/think-messages';
import { ToolFailureGuard, toolOutputError } from '../services/agent/tool-failure-guard';
import { createServerTools } from '../services/agent/tools';
import { createAdapter as createWorkersAiAdapter } from '../services/agent/workers-ai';

import type { AgentDebugLog } from '../services/agent/agent-logger';
import type { SnapshotContext } from '../services/agent/snapshot-manager';
import type { ToolFailureState } from '../services/agent/tool-failure-guard';
import type { FileChange } from '../services/agent/types';
import type {
	ChatResponseResult,
	ChunkContext,
	ThinkSubmissionInspection,
	StepContext,
	TurnConfig,
	TurnContext,
	PrepareStepContext,
} from '@cloudflare/think';
import type { StreamEvent } from '@shared/agent-state';
import type { AIModelId } from '@shared/constants';
import type { AgentMode, ChatMessage } from '@shared/types';
import type { Session } from 'agents/experimental/memory/session';
import type { StopCondition, ToolSet } from 'ai';

interface SessionTurnConfiguration {
	projectId: string;
	organizationId?: string;
	sessionId: string;
	requestOriginContext?: RequestOriginContext;
}

export interface TurnExecutionConfiguration {
	mode: AgentMode;
	model: AIModelId;
	initiatorUserId?: string;
	requestOriginContext?: RequestOriginContext;
}

interface ActiveTurnConfiguration extends TurnExecutionConfiguration {
	submissionId: string;
}

interface SessionTurnState {
	failureState?: ToolFailureState;
	configuration?: SessionTurnConfiguration;
	historyInitialized?: boolean;
	activeSubmissionId?: string;
	activeTurn?: ActiveTurnConfiguration;
	activeDebugLog?: AgentDebugLog;
	activeSnapshot?: {
		id: string;
		directory: string;
		savedPaths: string[];
	};
	pendingCompletion?: {
		submissionId: string;
		history: ChatMessage[];
		status: 'completed' | 'error' | 'aborted';
		error?: string;
		debugLog?: AgentDebugLog;
	};
}

/** A successful question ends the turn so the next model step receives the user's answer. */
export const shouldWaitForUser: StopCondition<ToolSet> = ({ steps }) =>
	steps.at(-1)?.toolResults.some((result) => result.toolName === 'user_question') ?? false;

export class SessionTurnAgent extends Think<Env, SessionTurnState> {
	initialState: SessionTurnState = {};
	chatStreamStallTimeoutMs = 600_000;
	maxSteps = 100;
	exposeMcpTools = false;
	private eventQueue: StreamEvent[] = [];
	private queryChanges = [];
	private eventAbortController = new AbortController();
	private completionPromise?: Promise<void>;
	private parentStub?: Promise<DurableObjectStub<AgentRunner>>;
	private eventBatcher = this.createEventBatcher();
	private debugLogger?: AgentLogger;
	private inputOverhead = 0;
	private failureGuard?: ToolFailureGuard;

	// Keep transcript rows intact; compaction only changes the inference overlay.
	override mediaEviction = false;

	// Retain interruption reconciliation, but never replay a turn or its tools.
	override async onChatRecovery() {
		return { continue: false };
	}

	override configureSession(session: Session): Session {
		return configureHarnessSession(session, () => ({ ...this.state.configuration, abortSignal: this.eventAbortController.signal }));
	}

	override contextOverflow = harnessContextGuard(DEFAULT_AI_MODEL);

	override async beforeStep(context: PrepareStepContext): Promise<void> {
		this.failureGuard?.assertHealthy();
		const estimatedTokens = estimateMessagesTokens(context.messages) + this.inputOverhead;
		await this.eventBatcher.enqueue([
			{
				type: 'context-utilization',
				estimatedTokens,
				contextWindow: getModelLimits(this.getModel()).contextWindow,
				utilization: estimatedTokens / getModelLimits(this.getModel()).contextWindow,
			},
		]);
	}

	override broadcast(_message: string | ArrayBuffer | ArrayBufferView, _without?: string[]): void {
		// This internal facet has no UI clients. Think persists its transcript
		// independently; the parent transports our batched application events.
		// Relaying the unused Think protocol would consume RPCs for every token.
	}

	override async onStart(): Promise<void> {
		await super.onStart();
		await registerConfiguredMcpServers(this).catch((error) => {
			console.error(
				`[SessionTurnAgent] Failed to connect configured MCP servers (${MCP_SERVERS.map((server) => server.id).join(', ')}):`,
				error,
			);
		});
		if (this.state.pendingCompletion) {
			await this.completePendingTurn();
			return;
		}
		await this.reconcileActiveSubmission();
	}

	async configureSessionTurn(configuration: SessionTurnConfiguration): Promise<{ needsHistory: boolean }> {
		this.setState({ ...this.state, configuration });
		if (this.state.historyInitialized) return { needsHistory: false };
		const messages = await this.getMessages();
		if (messages.length === 0) return { needsHistory: true };
		this.setState({ ...this.state, historyInitialized: true });
		return { needsHistory: false };
	}

	async initializeHistory(messages: ChatMessage[]): Promise<void> {
		if (this.state.historyInitialized) return;
		const existingMessages = await this.getMessages();
		if (existingMessages.length === 0 && messages.length > 0) {
			await this.addMessages(messages.map((message) => chatMessageToUiMessage(message)));
		}
		this.setState({ ...this.state, historyInitialized: true });
	}

	override getModel(): AIModelId {
		return this.state.activeTurn?.model ?? DEFAULT_AI_MODEL;
	}

	override getSystemPrompt(): string {
		return AGENT_SYSTEM_PROMPT;
	}

	override async beforeTurn(context: TurnContext): Promise<TurnConfig> {
		this.parentStub = undefined;
		this.eventBatcher = this.createEventBatcher();
		const configuration = this.requireConfiguration();
		const turnConfiguration = this.requireActiveTurn();
		const logger = this.getDebugLogger();
		logger?.info('agent_loop', context.continuation ? 'resumed' : 'started', { submissionId: turnConfiguration.submissionId });
		if (logger) this.setState({ ...this.state, activeDebugLog: logger.toJSON() });
		if (!context.continuation) {
			const parent = await this.getParentStub();
			await parent.beginThinkTurn(configuration.sessionId, turnConfiguration.submissionId);
		}
		const filesystemId = toDurableObjectId(filesystemNamespace, configuration.projectId);
		const filesystemStub = filesystemNamespace.get(filesystemId);
		await filesystemStub.beginComputerSessionTurn(
			configuration.sessionId,
			turnConfiguration.submissionId,
			turnConfiguration.mode,
			turnConfiguration.requestOriginContext ?? configuration.requestOriginContext,
		);
		const agentsContext = await runWithProjectStub(filesystemStub, () => readAgentsContext('/project'));
		this.contextOverflow = harnessContextGuard(this.getModel());
		const instructions = await buildSessionTurnInstructions(turnConfiguration.mode, agentsContext);
		logger?.debug('llm', 'request', { instructions, messages: context.messages });

		this.eventQueue = [];
		this.queryChanges = [];
		this.eventAbortController.abort();
		this.eventAbortController = new AbortController();
		if (this.state.failureState?.submissionId !== turnConfiguration.submissionId)
			this.setState({ ...this.state, failureState: { submissionId: turnConfiguration.submissionId, count: 0, seen: [] } });
		this.failureGuard = new ToolFailureGuard(
			() => this.state.failureState ?? { submissionId: turnConfiguration.submissionId, count: 0, seen: [] },
			(failureState) => {
				this.setState({ ...this.state, failureState });
				if (failureState.message) {
					this.eventQueue.push({
						type: 'doom-loop-detected',
						reason: 'repeated_error_pattern',
						toolName: undefined,
						message: failureState.message,
					});
					this.ctx.waitUntil(this.cancelWorkspaceCommands(turnConfiguration.submissionId).catch(() => {}));
				}
			},
		);
		const queuedSendEvent = createSendEventFunction(this.eventQueue, { current: undefined }, this.eventAbortController.signal);
		const sendEvent: typeof queuedSendEvent = (type, data) => {
			if (type === 'file_changed') this.failureGuard?.progress();
			queuedSendEvent(type, data);
		};
		if (turnConfiguration.mode === 'code' && !context.continuation) {
			const snapshot = await runWithProjectStub(
				filesystemStub,
				() => initSnapshot('/project', configuration.sessionId, context.messages, sendEvent),
				'/project',
				configuration.sessionId,
			);
			this.setState({
				...this.state,
				activeSnapshot: { id: snapshot.id, directory: snapshot.directory, savedPaths: [] },
			});
		}
		const tools = await createServerTools(
			sendEvent,
			{
				projectRoot: '/project',
				projectId: configuration.projectId,
				organizationId: configuration.organizationId,
				mode: turnConfiguration.mode,
				sessionId: configuration.sessionId,
				userId: turnConfiguration.initiatorUserId,
				callMcpTool: async (serverId, toolName, arguments_) => {
					const { callConfiguredMcpTool } = await import('../services/agent/mcp');
					return callConfiguredMcpTool(this, serverId, toolName, arguments_);
				},
				ctx: this.ctx,
				loader: this.env.LOADER,
				browser: this.env.BROWSER,
				agentReference: this,
				readCompletionReviewContext: async () => ({
					messages: uiMessagesToChatMessages(await this.getMessages()),
					changedPaths: this.state.activeSnapshot?.savedPaths ?? [],
					todos: [],
					observations: [],
					revision: 0,
					incomplete: Boolean(context.continuation),
				}),
				fsStub: filesystemStub,
				model: turnConfiguration.model,
				submissionId: turnConfiguration.submissionId,
				failureGuard: this.failureGuard,
				onToolOutput: async (event) => {
					if (this.state.activeSubmissionId === event.submissionId && !this.eventAbortController.signal.aborted)
						await this.eventBatcher.enqueue([event]);
				},
				requestOriginContext: turnConfiguration.requestOriginContext ?? configuration.requestOriginContext,
			},
			this.queryChanges,
			turnConfiguration.mode,
			logger,
		);

		this.inputOverhead = Math.ceil(
			(instructions.length +
				JSON.stringify(
					Object.entries(tools).map(([name, tool]) => ({ name, description: tool.description, inputSchema: tool.inputSchema })),
				).length) /
				4,
		);
		return {
			model: withHarnessContextBudget(
				createWorkersAiAdapter(turnConfiguration.model, {
					generationType: 'agent',
					projectId: configuration.projectId,
					organizationId: configuration.organizationId,
				}),
				turnConfiguration.model,
			),
			instructions,
			tools,
			maxSteps: this.maxSteps,
			stopWhen: shouldWaitForUser,
			chatStreamStallTimeoutMs: this.chatStreamStallTimeoutMs,
			maxRetries: HARNESS_MAX_RETRIES,
			maxOutputTokens: getModelLimits(turnConfiguration.model).maxOutput,
		};
	}

	override async onChunk(context: ChunkContext): Promise<void> {
		const events = drainEventQueue(this.eventQueue);
		const chunk = context.chunk;
		switch (chunk.type) {
			case 'text-delta': {
				events.push({ type: 'text-delta', delta: chunk.text });
				break;
			}
			case 'reasoning-delta': {
				events.push({ type: 'reasoning-delta', delta: chunk.text });
				break;
			}
			case 'tool-input-start': {
				events.push({ type: 'tool-call-start', toolCallId: chunk.id, toolName: chunk.toolName });
				break;
			}
			case 'tool-input-delta': {
				events.push({ type: 'tool-call-args-delta', toolCallId: chunk.id, delta: chunk.delta });
				break;
			}
			case 'tool-call': {
				const input: unknown = chunk.input;
				events.push({
					type: 'tool-call-start',
					toolCallId: chunk.toolCallId,
					toolName: chunk.toolName,
					arguments: input && typeof input === 'object' && !Array.isArray(input) ? Object.fromEntries(Object.entries(input)) : {},
				});
				break;
			}
			case 'tool-result': {
				events.push({
					type: 'tool-call-end',
					toolCallId: chunk.toolCallId,
					toolName: chunk.toolName,
					result: typeof chunk.output === 'string' ? chunk.output : JSON.stringify(chunk.output),
				});
				break;
			}
			default: {
				break;
			}
		}
		await this.saveSnapshotChanges(events);
		await this.eventBatcher.enqueue(events);
	}

	override async onStepEnd(context: StepContext): Promise<void> {
		for (const part of context.content) {
			if (part.type === 'tool-error')
				this.failureGuard?.record({ id: part.toolCallId, toolName: part.toolName, input: part.input, error: String(part.error) });
			if (part.type === 'tool-result' && part.toolName !== 'codemode')
				this.failureGuard?.record({ id: part.toolCallId, toolName: part.toolName, input: part.input, error: toolOutputError(part.output) });
		}

		const logger = this.debugLogger;
		if (logger) {
			logger.setIteration(context.stepNumber + 1);
			logger.recordTokenUsage(context.usage.inputTokens ?? 0, context.usage.outputTokens ?? 0);
			logger.info('llm', 'response', {
				text: context.text,
				reasoning: context.reasoning,
				finishReason: context.finishReason,
				usage: context.usage,
			});
			for (const result of context.toolCalls) logger.recordToolCall(result.toolName);
			for (const event of toolErrorEvents(context.content)) {
				if (event.type === 'tool-error') logger.error('tool_call', 'error', { ...event });
			}
			this.setState({ ...this.state, activeDebugLog: logger.toJSON() });
		}
		const events = [...drainEventQueue(this.eventQueue), ...toolErrorEvents(context.content)];
		await this.saveSnapshotChanges(events);
		await this.eventBatcher.enqueue(events);
		await this.eventBatcher.flush();
		this.failureGuard?.assertHealthy();
	}

	override async onChatResponse(result: ChatResponseResult): Promise<void> {
		const activeTurn = this.state.activeTurn;
		if (!activeTurn || activeTurn.submissionId !== result.requestId) return;
		const remainingEvents = drainEventQueue(this.eventQueue);
		await this.saveSnapshotChanges(remainingEvents);
		await this.eventBatcher.enqueue(remainingEvents);
		await this.eventBatcher.flush();
		// The SDK finalizes its submission ledger after this callback. In particular,
		// an aborted provider stream can report an error here while its submission is
		// correctly marked aborted. Publish terminal state only from onSubmissionStatus.
	}

	override async onSubmissionStatus(submission: ThinkSubmissionInspection): Promise<void> {
		if (submission.status === 'running') {
			const activeTurn = parseActiveTurnConfiguration(submission.metadata, submission.submissionId);
			const isNewTurn = this.state.activeSubmissionId !== submission.submissionId;
			if (isNewTurn) {
				this.debugLogger = undefined;
				this.eventAbortController.abort();
				this.eventAbortController = new AbortController();
			}
			this.setState({
				...this.state,
				activeSubmissionId: submission.submissionId,
				activeTurn,
				activeDebugLog: isNewTurn ? undefined : this.state.activeDebugLog,
				failureState: isNewTurn ? { submissionId: submission.submissionId, count: 0, seen: [] } : this.state.failureState,
			});
			const logger = this.getDebugLogger();
			if (logger) this.setState({ ...this.state, activeDebugLog: logger.toJSON() });
			return;
		}

		if (submission.status === 'pending' || this.state.activeSubmissionId !== submission.submissionId) return;
		await this.eventBatcher.flush().catch((error) => {
			// Preserve terminal state even when live updates failed. The parent's
			// scheduled reconciliation can deliver it from a fresh invocation.
			console.error('[SessionTurnAgent] Streaming events failed before completion:', error);
		});
		const terminal =
			this.state.failureState?.message && submission.status !== 'aborted'
				? ({ status: 'error', error: this.state.failureState.message } satisfies { status: 'error'; error: string })
				: getTerminalSubmissionResult(submission);
		const history = uiMessagesToChatMessages(await readHarnessTranscript(this.session));
		const logger = this.getDebugLogger();
		if (terminal.status === 'aborted') logger?.markAborted();
		if (terminal.error) logger?.error('agent_loop', terminal.status, { message: terminal.error });
		logger?.info('agent_loop', 'finished', { status: terminal.status });
		logger?.debug('message', 'history', { messages: history });
		this.setState({
			...this.state,
			pendingCompletion: {
				submissionId: submission.submissionId,
				history,
				status: terminal.status,
				error: terminal.error,
				debugLog: logger?.toJSON(),
			},
		});
		await this.completePendingTurn();
	}

	async submitTurn(
		message: ChatMessage,
		configuration: TurnExecutionConfiguration,
	): Promise<{ accepted: boolean; status: string; submissionId: string }> {
		const result = await this.runTurn({
			mode: 'submit',
			input: userMessageToUiMessage(message),
			submissionId: message.id,
			idempotencyKey: message.id,
			metadata: { ...configuration, submissionId: message.id },
		});
		return { accepted: result.accepted, status: result.status, submissionId: result.submissionId };
	}

	async replaceHistory(messages: ChatMessage[]): Promise<void> {
		await this.clearMessages();
		if (messages.length > 0) {
			await this.addMessages(messages.map((message) => chatMessageToUiMessage(message)));
		}
		this.setState({ ...this.state, historyInitialized: true });
	}

	async cancelSubmissionById(submissionId: string): Promise<void> {
		if (this.state.activeSubmissionId === submissionId) this.eventAbortController.abort();
		await this.cancelSubmission(submissionId, 'Cancelled by user');
	}

	async cancelActiveSubmissions(): Promise<void> {
		const submissions = await this.listSubmissions({ status: ['pending', 'running'] });
		const runningSubmission = submissions.find((submission) => submission.status === 'running');
		if (runningSubmission) {
			// Workspace cancellation must not delay aborting inference or publishing its terminal state.
			this.ctx.waitUntil(
				this.cancelWorkspaceCommands(runningSubmission.submissionId).catch((error) => {
					console.error('[SessionTurnAgent] Failed to cancel workspace commands:', error);
				}),
			);
		}
		// Remove pending work first so stopping the active turn cannot start the next one.
		for (const submission of submissions.filter((submission) => submission.status === 'pending')) {
			await this.cancelSubmission(submission.submissionId, 'Cancelled by user');
		}
		if (runningSubmission) {
			this.eventAbortController.abort();
			await this.cancelSubmission(runningSubmission.submissionId, 'Cancelled by user');
		}
	}

	private async cancelWorkspaceCommands(submissionId: string): Promise<void> {
		const configuration = this.requireConfiguration();
		const identifier = toDurableObjectId(filesystemNamespace, configuration.projectId);
		await filesystemNamespace.get(identifier).cancelComputerSessionExecutions(configuration.sessionId, submissionId);
	}

	async receiveSubAgentEvents(events: StreamEvent[]): Promise<void> {
		await this.saveSnapshotChanges(events);
		await this.eventBatcher.enqueue(events);
	}

	async reconcileSessionTurn(): Promise<void> {
		this.parentStub = undefined;
		if (this.state.pendingCompletion) {
			await this.completePendingTurn();
			return;
		}
		await this.reconcileActiveSubmission();
	}

	async persistDebugLog(log: AgentDebugLog): Promise<void> {
		const configuration = this.requireConfiguration();
		if (log.projectId !== configuration.projectId || log.sessionId !== configuration.sessionId)
			throw new Error('Invalid debug log session.');
		const logger = new AgentLogger(log.sessionId, log.projectId, log.model, log.mode, log);
		const filesystemId = toDurableObjectId(filesystemNamespace, configuration.projectId);
		await runWithProjectStub(filesystemNamespace.get(filesystemId), () => logger.flush('/project', log));
		if (!logger.isFlushed) throw new Error('Failed to persist agent debug log.');
		const parent = await this.getParentStub();
		await parent.setSessionDebugLogId(configuration.sessionId, log.id);
	}

	private getDebugLogger(): AgentLogger | undefined {
		if (this.debugLogger) return this.debugLogger;
		const configuration = this.state.configuration;
		const turn = this.state.activeTurn;
		if (!configuration || !turn) return undefined;
		this.debugLogger = new AgentLogger(configuration.sessionId, configuration.projectId, turn.model, turn.mode, this.state.activeDebugLog);
		return this.debugLogger;
	}

	private createEventBatcher(): SessionEventBatcher {
		return new SessionEventBatcher(
			(events) => this.forwardEvents(events),
			(promise) => this.ctx.waitUntil(promise),
		);
	}

	private getParentStub(): Promise<DurableObjectStub<AgentRunner>> {
		this.parentStub ??= this.parentAgent(AgentRunner).catch((error) => {
			this.parentStub = undefined;
			throw error;
		});
		return this.parentStub;
	}

	private requireConfiguration(): SessionTurnConfiguration {
		const configuration = this.state.configuration;
		if (!configuration) {
			throw new Error('Session turn agent is not configured.');
		}
		return configuration;
	}

	private requireActiveTurn(): ActiveTurnConfiguration {
		const configuration = this.state.activeTurn;
		if (!configuration) throw new Error('Turn execution configuration is missing or invalid.');
		return configuration;
	}

	private async forwardEvents(events: StreamEvent[]): Promise<void> {
		if (events.length === 0) return;
		const configuration = this.requireConfiguration();
		const parent = await this.getParentStub();
		await parent.receiveThinkEvents(configuration.sessionId, events);
	}

	private async saveSnapshotChanges(events: StreamEvent[]): Promise<void> {
		const snapshot = this.getSnapshotContext();
		if (!snapshot) return;

		const changes: FileChange[] = events.flatMap((event) => {
			if (event.type !== 'file-changed' || event.action === 'move') return [];
			return [
				{
					path: event.path,
					action: event.action,
					beforeContent: event.beforeBytes === undefined ? event.beforeContent : new Uint8Array(Buffer.from(event.beforeBytes, 'base64')),
					afterContent: event.afterBytes === undefined ? event.afterContent : new Uint8Array(Buffer.from(event.afterBytes, 'base64')),
					isBinary: event.isBinary ?? false,
					entryType: event.entryType,
					beforeEntryType: event.beforeEntryType,
				},
			];
		});
		if (changes.length === 0) return;

		const configuration = this.requireConfiguration();
		const filesystemId = toDurableObjectId(filesystemNamespace, configuration.projectId);
		const filesystemStub = filesystemNamespace.get(filesystemId);
		await runWithProjectStub(
			filesystemStub,
			async () => {
				for (const change of changes) {
					await addFileToSnapshot(snapshot, change);
				}
			},
			'/project',
			configuration.sessionId,
		);
		this.setState({
			...this.state,
			activeSnapshot: { id: snapshot.id, directory: snapshot.directory, savedPaths: [...snapshot.savedPaths] },
		});
	}

	private completePendingTurn(): Promise<void> {
		if (this.completionPromise) return this.completionPromise;
		const completionPromise = this.completePendingTurnInner().finally(() => {
			if (this.completionPromise === completionPromise) this.completionPromise = undefined;
		});
		this.completionPromise = completionPromise;
		return completionPromise;
	}

	private async completePendingTurnInner(): Promise<void> {
		const completion = this.state.pendingCompletion;
		if (!completion) return;

		const snapshot = this.getSnapshotContext();
		const emptySnapshot = snapshot?.savedPaths.size === 0 ? snapshot : undefined;
		if (emptySnapshot) {
			await this.forwardEvents([{ type: 'snapshot-deleted', id: emptySnapshot.id }]);
		}

		const submissions = await this.listSubmissions({ status: ['pending', 'running'] });
		const activeSubmissions = submissions
			.filter((submission) => submission.submissionId !== completion.submissionId)
			.map((submission) => {
				const status: 'pending' | 'running' = submission.status === 'running' ? 'running' : 'pending';
				return { submissionId: submission.submissionId, status };
			});
		const configuration = this.requireConfiguration();
		const parent = await this.getParentStub();
		await parent.completeThinkTurn(
			configuration.sessionId,
			completion.submissionId,
			emptySnapshot ? clearSnapshotFromMessages(completion.history, emptySnapshot.id) : completion.history,
			completion.status,
			completion.error,
			activeSubmissions,
		);
		if (completion.debugLog) await this.queue('persistDebugLog', completion.debugLog);
		const completingActiveTurn = this.state.activeTurn?.submissionId === completion.submissionId;
		this.setState({
			...this.state,
			activeSubmissionId: this.state.activeSubmissionId === completion.submissionId ? undefined : this.state.activeSubmissionId,
			activeTurn: this.state.activeTurn?.submissionId === completion.submissionId ? undefined : this.state.activeTurn,
			activeSnapshot: undefined,
			pendingCompletion: undefined,
			activeDebugLog: completingActiveTurn ? undefined : this.state.activeDebugLog,
		});
		if (completingActiveTurn) this.debugLogger = undefined;
		if (emptySnapshot) {
			// An execution can retain the mutation queue while it synchronizes. Cleanup
			// must not keep the session running behind that queue.
			this.ctx.waitUntil(
				this.deleteEmptySnapshot(emptySnapshot).catch((error) => {
					console.error('[SessionTurnAgent] Failed to clean up empty snapshot:', error);
				}),
			);
		}
	}

	private async deleteEmptySnapshot(snapshot: SnapshotContext): Promise<void> {
		const configuration = this.requireConfiguration();
		const filesystemId = toDurableObjectId(filesystemNamespace, configuration.projectId);
		await runWithProjectStub(
			filesystemNamespace.get(filesystemId),
			() => deleteDirectoryRecursive(snapshot.directory),
			'/project',
			configuration.sessionId,
		);
	}

	private async reconcileActiveSubmission(): Promise<void> {
		const submissionId = this.state.activeSubmissionId;
		if (!submissionId) return;
		const submission = await this.inspectSubmission(submissionId);
		if (!submission || submission.status === 'pending' || submission.status === 'running') return;
		await this.onSubmissionStatus(submission);
	}

	private getSnapshotContext(): SnapshotContext | undefined {
		const snapshot = this.state.activeSnapshot;
		if (!snapshot) return undefined;
		return { id: snapshot.id, directory: snapshot.directory, savedPaths: new Set(snapshot.savedPaths) };
	}
}

export function parseActiveTurnConfiguration(
	metadata: Record<string, unknown> | undefined,
	submissionId: string,
): ActiveTurnConfiguration | undefined {
	if (!metadata) return undefined;
	const mode = metadata.mode;
	if (mode !== 'code' && mode !== 'plan' && mode !== 'ask') return undefined;
	const parsedModel = aiModelSchema.safeParse(metadata.model);
	if (!parsedModel.success) return undefined;
	return {
		submissionId,
		mode,
		model: parsedModel.data,
		initiatorUserId: typeof metadata.initiatorUserId === 'string' ? metadata.initiatorUserId : undefined,
		requestOriginContext: isRequestOriginContext(metadata.requestOriginContext) ? metadata.requestOriginContext : undefined,
	};
}

export function getTerminalSubmissionResult(submission: ThinkSubmissionInspection): {
	status: 'completed' | 'error' | 'aborted';
	error?: string;
} {
	if (submission.status === 'completed') return { status: 'completed' };
	if (submission.status === 'aborted') return { status: 'aborted', error: submission.error };
	return {
		status: 'error',
		error:
			submission.error ?? (submission.status === 'skipped' ? 'The agent turn was skipped before it could run.' : 'The agent turn failed.'),
	};
}

export async function buildSessionTurnInstructions(mode: AgentMode, agentsContext?: string): Promise<string> {
	const modeInstructions = await buildRuntimePromptAdditions('/project', mode);
	const projectInstructions = agentsContext ? `\n\n## Project Guidelines (from AGENTS.md)\n${agentsContext}` : '';
	return `${AGENT_SYSTEM_PROMPT}\n\n${modeInstructions}${projectInstructions}`;
}
