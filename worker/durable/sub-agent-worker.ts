import { AsyncLocalStorage } from 'node:async_hooks';

import { getWorkspace } from '@cloudflare/computer';
import { Think } from '@cloudflare/think';

import { mergeCommandOutput } from '@shared/command-output';
import { DEFAULT_AI_MODEL, getModelLimits } from '@shared/constants';
import { aiModelSchema } from '@shared/validation';

import { SessionTurnAgent } from './session-turn-agent';
import { ToolOutputBatcher } from './tool-output-batcher';
import { filesystemNamespace } from '../lib/durable-object-namespaces';
import { runWithProjectStub } from '../lib/project-fs';
import { toDurableObjectId } from '../lib/project-id';
import { createSendEventFunction, drainEventQueue, toolErrorEvents } from '../services/agent/event-helpers';
import {
	configureHarnessSession,
	HARNESS_MAX_RETRIES,
	harnessContextGuard,
	withHarnessContextBudget,
} from '../services/agent/harness-session';
import { isRequestOriginContext } from '../services/agent/request-origin-context';
import { readAgentsContext } from '../services/agent/system-prompt-builder';
import { ToolFailureGuard, toolOutputError } from '../services/agent/tool-failure-guard';
import { createServerTools, SUB_AGENT_EXCLUDED_TOOLS } from '../services/agent/tools';
import { createAdapter as createWorkersAiAdapter } from '../services/agent/workers-ai';

import type { RequestOriginContext } from '../services/agent/request-origin-context';
import type { ToolFailureState } from '../services/agent/tool-failure-guard';
import type { ChatResponseResult, StepContext, TurnConfig, TurnContext, ThinkSubmissionInspection, Session } from '@cloudflare/think';
import type { StreamEvent } from '@shared/agent-state';
import type { ToolCommandOutput } from '@shared/command-output';
import type { AIModelId } from '@shared/constants';
import type { UIMessage } from 'ai';

const SUB_AGENT_SYSTEM_PROMPT =
	'You are a focused sub-agent. Complete the delegated task efficiently and end with a concise, self-contained result for the parent agent.';

interface SubAgentInput {
	prompt: string;
	projectId: string;
	organizationId?: string;
	model: AIModelId;
	sessionId: string;
	userId?: string;
	requestOriginContext?: RequestOriginContext;
	parentToolCallId?: string;
	parentSubmissionId?: string;
}

interface SubAgentState {
	failureState?: ToolFailureState;
	input?: SubAgentInput;
}

export class SubAgentWorker extends Think<Env, SubAgentState> {
	initialState: SubAgentState = {};
	override workspace = getWorkspace({
		__getWorkspaceStub: () => {
			const input = this.state.input;
			if (!input) throw new Error('Missing task configuration');
			return filesystemNamespace.get(toDurableObjectId(filesystemNamespace, input.projectId)).getAgentWorkspace(input.sessionId);
		},
	});
	override getTools() {
		return {};
	}
	chatStreamStallTimeoutMs = 600_000;
	maxSteps = 100;
	includeMcpTools = false;
	override chatRecovery = { maxInterruptedAttempts: 5, maxAttempts: 2 };
	private eventQueue: StreamEvent[] = [];
	private failureGuard?: ToolFailureGuard;
	private commandOutput?: ToolCommandOutput;
	private runInTurn = AsyncLocalStorage.snapshot();
	private outputBatcher = this.createOutputBatcher();
	private createOutputBatcher(): ToolOutputBatcher {
		return new ToolOutputBatcher(
			async (events) => {
				for (const event of events)
					if (event.type === 'tool-output') this.commandOutput = mergeCommandOutput(this.commandOutput, event.output);
				if (this.commandOutput)
					await this.runInTurn(() =>
						this.reportProgress({ phase: 'command', data: { commandOutput: this.commandOutput } }, { persist: true }),
					);
			},
			(promise) => this.ctx.waitUntil(promise),
		);
	}
	// Keep transcript rows intact; compaction only changes the inference overlay.
	override mediaEviction = false;

	// Retain interruption reconciliation, but never replay a turn or its tools.
	override async onChatRecovery() {
		if (!this.state.input || this.ctx.storage.kv.get('mutation-started')) return { continue: false };
		const input = this.state.input;
		const executions = await filesystemNamespace
			.get(toDurableObjectId(filesystemNamespace, input.projectId))
			.getComputerExecutions(input.sessionId);
		return { continue: !executions.some((execution) => ['starting', 'running', 'synchronization-pending'].includes(execution.status)) };
	}

	override configureSession(session: Session): Session {
		return configureHarnessSession(session, () => ({ ...this.state.input, abortSignal: this.eventAbortController.signal }));
	}
	override contextOverflow = harnessContextGuard(DEFAULT_AI_MODEL);
	override beforeStep(): void {
		this.failureGuard?.assertHealthy();
	}

	private eventAbortController = new AbortController();

	override formatAgentToolInput(value: unknown): UIMessage {
		const input = parseSubAgentInput(value);
		this.eventAbortController.abort();
		this.eventAbortController = new AbortController();
		this.setState({ input });
		return {
			id: crypto.randomUUID(),
			role: 'user',
			parts: [{ type: 'text', text: input.prompt }],
		};
	}

	override async onSubmissionStatus(submission: ThinkSubmissionInspection): Promise<void> {
		if (submission.status === 'aborted') this.eventAbortController.abort();
	}

	override getModel(): AIModelId {
		return this.state.input?.model ?? DEFAULT_AI_MODEL;
	}

	override getSystemPrompt(): string {
		return SUB_AGENT_SYSTEM_PROMPT;
	}

	override async beforeTurn(context: TurnContext): Promise<TurnConfig> {
		this.runInTurn = AsyncLocalStorage.snapshot();
		const input = this.state.input;
		if (!input) throw new Error('Sub-agent input is not configured.');

		const filesystemId = toDurableObjectId(filesystemNamespace, input.projectId);
		const filesystemStub = filesystemNamespace.get(filesystemId);
		const agentsContext = await runWithProjectStub(filesystemStub, () => readAgentsContext('/project'));
		this.contextOverflow = harnessContextGuard(this.getModel());
		const instructions = agentsContext ? `${context.system}\n\n## Project Guidelines (from AGENTS.md)\n${agentsContext}` : context.system;
		this.eventQueue = [];
		this.outputBatcher = this.createOutputBatcher();
		this.eventAbortController.abort();
		this.eventAbortController = new AbortController();
		const controller = this.eventAbortController;
		context.abortSignal?.throwIfAborted();
		context.abortSignal?.addEventListener('abort', () => controller.abort(), { once: true });
		const submissionId = this.state.failureState?.submissionId ?? crypto.randomUUID();
		this.setState({ ...this.state, failureState: this.state.failureState ?? { submissionId, count: 0, seen: [] } });
		this.failureGuard = new ToolFailureGuard(
			() => this.state.failureState ?? { submissionId, count: 0, seen: [] },
			(failureState) => {
				this.setState({ ...this.state, failureState });
				if (failureState.message)
					this.eventQueue.push({
						type: 'doom-loop-detected',
						reason: 'repeated_error_pattern',
						toolName: undefined,
						message: failureState.message,
					});
			},
		);
		const queuedSendEvent = createSendEventFunction(this.eventQueue, { current: undefined }, this.eventAbortController.signal);
		const sendEvent: typeof queuedSendEvent = (type, data) => {
			if (type === 'file_changed') this.failureGuard?.progress();
			queuedSendEvent(type, data);
		};
		const parent = await this.parentAgent(SessionTurnAgent);
		const tools = await createServerTools(
			sendEvent,
			{
				projectRoot: '/project',
				projectId: input.projectId,
				organizationId: input.organizationId,
				mode: 'code',
				beforeMutation: async () => {
					this.ctx.storage.kv.put('mutation-started', true);
					await parent.recordMutation(input.parentSubmissionId ?? '');
				},
				abortSignal: this.eventAbortController.signal,
				reviewSubmissionId: input.parentSubmissionId,
				sessionId: input.sessionId,
				userId: input.userId,
				callMcpTool: (serverId, toolName, arguments_) => parent.callProjectMcpTool(serverId, toolName, arguments_),
				listMcpTools: () => parent.listProjectMcpTools(),
				isSubAgent: true,
				ctx: this.ctx,
				loader: this.env.LOADER,
				browser: this.env.BROWSER,
				agentReference: this,
				fsStub: filesystemStub,
				model: input.model,
				submissionId,
				failureGuard: this.failureGuard,
				onToolOutput: (event) => this.outputBatcher.enqueue([{ ...event, submissionId: input.parentSubmissionId ?? event.submissionId }]),
				requestOriginContext: input.requestOriginContext,
			},
			[],
			'code',
			undefined,
			SUB_AGENT_EXCLUDED_TOOLS,
		);

		return {
			model: withHarnessContextBudget(
				createWorkersAiAdapter(input.model, {
					generationType: 'agent',
					projectId: input.projectId,
					organizationId: input.organizationId,
				}),
				input.model,
			),
			instructions,
			tools,
			activeTools: Object.keys(tools),
			maxSteps: this.maxSteps,
			chatStreamStallTimeoutMs: this.chatStreamStallTimeoutMs,
			maxRetries: HARNESS_MAX_RETRIES,
			maxOutputTokens: getModelLimits(input.model).maxOutput,
		};
	}

	override async onChatResponse(_result: ChatResponseResult): Promise<void> {
		await this.forwardParentEvents();
		await this.outputBatcher.flush();
		this.failureGuard?.assertHealthy();
	}

	override async onStepEnd(context: StepContext): Promise<void> {
		for (const part of context.content) {
			if (part.type === 'tool-error')
				this.failureGuard?.record({ id: part.toolCallId, toolName: part.toolName, input: part.input, error: String(part.error) });
			if (part.type === 'tool-result' && part.toolName !== 'codemode')
				this.failureGuard?.record({ id: part.toolCallId, toolName: part.toolName, input: part.input, error: toolOutputError(part.output) });
		}
		this.eventQueue.push(...toolErrorEvents(context.content));
		await this.forwardParentEvents();
		this.failureGuard?.assertHealthy();
	}

	private async forwardParentEvents(): Promise<void> {
		const events = drainEventQueue(this.eventQueue).filter((event) => event.type === 'file-changed');
		if (events.length === 0) return;

		const { SessionTurnAgent } = await import('./session-turn-agent');
		const parent = await this.parentAgent(SessionTurnAgent);
		await parent.receiveSubAgentEvents(events, this.state.input?.parentSubmissionId ?? '');
	}
}

function parseSubAgentInput(value: unknown): SubAgentInput {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid sub-agent input.');
	if (!('prompt' in value) || typeof value.prompt !== 'string' || !value.prompt.trim()) throw new Error('A prompt is required.');
	if (!('projectId' in value) || typeof value.projectId !== 'string') throw new Error('A project ID is required.');
	if (!('model' in value) || typeof value.model !== 'string') throw new Error('A model is required.');
	if (!('sessionId' in value) || typeof value.sessionId !== 'string') throw new Error('A session ID is required.');

	return {
		prompt: value.prompt.trim(),
		projectId: value.projectId,
		model: aiModelSchema.parse(value.model),
		sessionId: value.sessionId,
		organizationId: 'organizationId' in value && typeof value.organizationId === 'string' ? value.organizationId : undefined,
		userId: 'userId' in value && typeof value.userId === 'string' ? value.userId : undefined,
		requestOriginContext:
			'requestOriginContext' in value && isRequestOriginContext(value.requestOriginContext) ? value.requestOriginContext : undefined,
		parentSubmissionId:
			'parentSubmissionId' in value && typeof value.parentSubmissionId === 'string' ? value.parentSubmissionId : undefined,
		parentToolCallId: 'parentToolCallId' in value && typeof value.parentToolCallId === 'string' ? value.parentToolCallId : undefined,
	};
}
