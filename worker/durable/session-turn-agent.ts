import { Buffer } from 'node:buffer';

import { Think } from '@cloudflare/think';

import { AGENT_SYSTEM_PROMPT, DEFAULT_AI_MODEL, MCP_SERVERS } from '@shared/constants';
import { aiModelSchema } from '@shared/validation';

import { AgentRunner } from './agent-runner';
import { clearSnapshotFromMessages } from './session-history';
import { filesystemNamespace } from '../lib/durable-object-namespaces';
import { runWithProjectStub } from '../lib/project-fs';
import { toDurableObjectId } from '../lib/project-id';
import { createSendEventFunction, drainEventQueue, toolErrorEvents } from '../services/agent/event-helpers';
import { registerConfiguredMcpServers } from '../services/agent/mcp';
import { isRequestOriginContext, type RequestOriginContext } from '../services/agent/request-origin-context';
import { addFileToSnapshot, deleteDirectoryRecursive, initSnapshot } from '../services/agent/snapshot-manager';
import { buildRuntimePromptAdditions, readAgentsContext } from '../services/agent/system-prompt-builder';
import { chatMessageToUiMessage, uiMessagesToChatMessages, userMessageToUiMessage } from '../services/agent/think-messages';
import { createServerTools } from '../services/agent/tools';
import { createAdapter as createWorkersAiAdapter } from '../services/agent/workers-ai';

import type { SnapshotContext } from '../services/agent/snapshot-manager';
import type { FileChange } from '../services/agent/types';
import type { ChatResponseResult, ChunkContext, ThinkSubmissionInspection, StepContext, TurnConfig, TurnContext } from '@cloudflare/think';
import type { StreamEvent } from '@shared/agent-state';
import type { AIModelId } from '@shared/constants';
import type { AgentMode, ChatMessage } from '@shared/types';
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
	configuration?: SessionTurnConfiguration;
	historyInitialized?: boolean;
	activeSubmissionId?: string;
	activeTurn?: ActiveTurnConfiguration;
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
		const configuration = this.requireConfiguration();
		const turnConfiguration = this.requireActiveTurn();
		if (!context.continuation) {
			const parent = await this.parentAgent(AgentRunner);
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
		const instructions = await buildSessionTurnInstructions(turnConfiguration.mode, agentsContext);

		this.eventQueue = [];
		this.queryChanges = [];
		this.eventAbortController.abort();
		this.eventAbortController = new AbortController();
		const sendEvent = createSendEventFunction(this.eventQueue, { current: undefined }, this.eventAbortController.signal);
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
				fsStub: filesystemStub,
				model: turnConfiguration.model,
				requestOriginContext: turnConfiguration.requestOriginContext ?? configuration.requestOriginContext,
			},
			this.queryChanges,
			turnConfiguration.mode,
		);

		return {
			model: createWorkersAiAdapter(turnConfiguration.model, {
				generationType: 'agent',
				projectId: configuration.projectId,
				organizationId: configuration.organizationId,
			}),
			instructions,
			tools,
			maxSteps: this.maxSteps,
			stopWhen: shouldWaitForUser,
			chatStreamStallTimeoutMs: this.chatStreamStallTimeoutMs,
			maxRetries: 0,
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
		await this.forwardEvents(events);
	}

	override async onStepEnd(context: StepContext): Promise<void> {
		const events = [...drainEventQueue(this.eventQueue), ...toolErrorEvents(context.content)];
		await this.saveSnapshotChanges(events);
		await this.forwardEvents(events);
	}

	override async onChatResponse(result: ChatResponseResult): Promise<void> {
		const activeTurn = this.state.activeTurn;
		if (!activeTurn || activeTurn.submissionId !== result.requestId) return;
		const remainingEvents = drainEventQueue(this.eventQueue);
		await this.saveSnapshotChanges(remainingEvents);
		await this.forwardEvents(remainingEvents);
		// The SDK finalizes its submission ledger after this callback. In particular,
		// an aborted provider stream can report an error here while its submission is
		// correctly marked aborted. Publish terminal state only from onSubmissionStatus.
	}

	override async onSubmissionStatus(submission: ThinkSubmissionInspection): Promise<void> {
		if (submission.status === 'running') {
			const activeTurn = parseActiveTurnConfiguration(submission.metadata, submission.submissionId);
			this.setState({ ...this.state, activeSubmissionId: submission.submissionId, activeTurn });
			return;
		}

		if (submission.status === 'pending' || this.state.activeSubmissionId !== submission.submissionId) return;
		const terminal = getTerminalSubmissionResult(submission);
		const history = uiMessagesToChatMessages(await this.getMessages());
		this.setState({
			...this.state,
			pendingCompletion: {
				submissionId: submission.submissionId,
				history,
				status: terminal.status,
				error: terminal.error,
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
		if (runningSubmission) await this.cancelSubmission(runningSubmission.submissionId, 'Cancelled by user');
	}

	private async cancelWorkspaceCommands(submissionId: string): Promise<void> {
		const configuration = this.requireConfiguration();
		const identifier = toDurableObjectId(filesystemNamespace, configuration.projectId);
		await filesystemNamespace.get(identifier).cancelComputerSessionExecutions(configuration.sessionId, submissionId);
	}

	async receiveSubAgentEvents(events: StreamEvent[]): Promise<void> {
		await this.saveSnapshotChanges(events);
		await this.forwardEvents(events);
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
		const parent = await this.parentAgent(AgentRunner);
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
		const parent = await this.parentAgent(AgentRunner);
		await parent.completeThinkTurn(
			configuration.sessionId,
			completion.submissionId,
			emptySnapshot ? clearSnapshotFromMessages(completion.history, emptySnapshot.id) : completion.history,
			completion.status,
			completion.error,
			activeSubmissions,
		);
		this.setState({
			...this.state,
			activeSubmissionId: this.state.activeSubmissionId === completion.submissionId ? undefined : this.state.activeSubmissionId,
			activeTurn: this.state.activeTurn?.submissionId === completion.submissionId ? undefined : this.state.activeTurn,
			activeSnapshot: undefined,
			pendingCompletion: undefined,
		});
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
