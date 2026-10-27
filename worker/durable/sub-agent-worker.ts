import { Think } from '@cloudflare/think';

import { DEFAULT_AI_MODEL, MCP_SERVERS, getModelLimits } from '@shared/constants';
import { aiModelSchema } from '@shared/validation';

import { SessionEventBatcher } from './session-event-batcher';
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
import { callConfiguredMcpTool, registerConfiguredMcpServers } from '../services/agent/mcp';
import { isRequestOriginContext } from '../services/agent/request-origin-context';
import { readAgentsContext } from '../services/agent/system-prompt-builder';
import { ToolFailureGuard, toolOutputError } from '../services/agent/tool-failure-guard';
import { createServerTools, SUB_AGENT_EXCLUDED_TOOLS } from '../services/agent/tools';
import { createAdapter as createWorkersAiAdapter } from '../services/agent/workers-ai';

import type { RequestOriginContext } from '../services/agent/request-origin-context';
import type { ToolFailureState } from '../services/agent/tool-failure-guard';
import type { ChatResponseResult, ChunkContext, StepContext, TurnConfig, TurnContext, ThinkSubmissionInspection } from '@cloudflare/think';
import type { StreamEvent } from '@shared/agent-state';
import type { AIModelId } from '@shared/constants';
import type { Session } from 'agents/experimental/memory/session';
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
	chatStreamStallTimeoutMs = 600_000;
	maxSteps = 100;
	exposeMcpTools = false;
	private eventQueue: StreamEvent[] = [];
	private failureGuard?: ToolFailureGuard;
	private outputBatcher = this.createOutputBatcher();
	private createOutputBatcher(parentToolCallId?: string): SessionEventBatcher {
		return new SessionEventBatcher(
			async (events) => {
				const { SessionTurnAgent } = await import('./session-turn-agent');
				const parent = await this.parentAgent(SessionTurnAgent);
				await parent.receiveSubAgentEvents(buildSubAgentParentEvents(events, parentToolCallId));
			},
			(promise) => this.ctx.waitUntil(promise),
		);
	}
	// Keep transcript rows intact; compaction only changes the inference overlay.
	override mediaEviction = false;

	// Retain interruption reconciliation, but never replay a turn or its tools.
	override async onChatRecovery() {
		return { continue: false };
	}

	override configureSession(session: Session): Session {
		return configureHarnessSession(session, () => ({ ...this.state.input, abortSignal: this.eventAbortController.signal }));
	}
	override contextOverflow = harnessContextGuard(DEFAULT_AI_MODEL);
	override beforeStep(): void {
		this.failureGuard?.assertHealthy();
	}

	private eventAbortController = new AbortController();

	override async onStart(): Promise<void> {
		await super.onStart();
		await registerConfiguredMcpServers(this).catch((error) => {
			console.error(
				`[SubAgentWorker] Failed to connect configured MCP servers (${MCP_SERVERS.map((server) => server.id).join(', ')}):`,
				error,
			);
		});
	}

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

	override async beforeTurn(_context: TurnContext): Promise<TurnConfig> {
		const input = this.state.input;
		if (!input) throw new Error('Sub-agent input is not configured.');

		const filesystemId = toDurableObjectId(filesystemNamespace, input.projectId);
		const filesystemStub = filesystemNamespace.get(filesystemId);
		const agentsContext = await runWithProjectStub(filesystemStub, () => readAgentsContext('/project'));
		this.contextOverflow = harnessContextGuard(this.getModel());
		const instructions = agentsContext
			? `${SUB_AGENT_SYSTEM_PROMPT}\n\n## Project Guidelines (from AGENTS.md)\n${agentsContext}`
			: SUB_AGENT_SYSTEM_PROMPT;
		this.eventQueue = [];
		this.outputBatcher = this.createOutputBatcher(input.parentToolCallId);
		this.eventAbortController.abort();
		this.eventAbortController = new AbortController();
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
		const tools = await createServerTools(
			sendEvent,
			{
				projectRoot: '/project',
				projectId: input.projectId,
				organizationId: input.organizationId,
				mode: 'code',
				sessionId: input.sessionId,
				userId: input.userId,
				callMcpTool: (serverId, toolName, arguments_) => callConfiguredMcpTool(this, serverId, toolName, arguments_),
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
			undefined,
			undefined,
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
			maxSteps: this.maxSteps,
			chatStreamStallTimeoutMs: this.chatStreamStallTimeoutMs,
			maxRetries: HARNESS_MAX_RETRIES,
			maxOutputTokens: getModelLimits(input.model).maxOutput,
		};
	}

	override async onChunk(context: ChunkContext): Promise<void> {
		if (context.chunk.type === 'tool-result' || context.chunk.type === 'tool-error') {
			await this.outputBatcher.flush();
			this.outputBatcher.completeTool(context.chunk.toolCallId);
			const parentToolCallId = this.state.input?.parentToolCallId;
			if (parentToolCallId) {
				const chunk = context.chunk;
				this.eventQueue.push({
					type: 'sub-agent-activity',
					parentToolCallId,
					activity: {
						kind: 'tool-end',
						toolCallId: chunk.toolCallId,
						toolName: chunk.toolName,
						result:
							chunk.type === 'tool-result'
								? typeof chunk.output === 'string'
									? chunk.output
									: JSON.stringify(chunk.output)
								: String(chunk.error),
						isError: chunk.type === 'tool-error',
					},
				});
			}
		}
		await this.forwardParentEvents();
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
		const events = buildSubAgentParentEvents(drainEventQueue(this.eventQueue), this.state.input?.parentToolCallId);
		if (events.length === 0) return;

		const { SessionTurnAgent } = await import('./session-turn-agent');
		const parent = await this.parentAgent(SessionTurnAgent);
		await parent.receiveSubAgentEvents(events);
	}
}

export function buildSubAgentParentEvents(events: StreamEvent[], parentToolCallId?: string): StreamEvent[] {
	return events.flatMap<StreamEvent>((event) => {
		if (event.type === 'file-changed' || event.type === 'sub-agent-activity' || event.type === 'doom-loop-detected') return [event];
		if (!parentToolCallId) return [];
		if (event.type === 'tool-output') return [{ type: 'sub-agent-activity', parentToolCallId, activity: { kind: 'tool-output', event } }];
		if (event.type === 'tool-error')
			return [
				{
					type: 'sub-agent-activity',
					parentToolCallId,
					activity: {
						kind: 'tool-metadata',
						...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
						toolName: event.toolName,
						title: 'Error',
						metadata: { error: event.errorMessage, errorCode: event.errorCode },
					},
				},
			];
		if (event.type !== 'tool-result') return [];
		return [
			{
				type: 'sub-agent-activity',
				parentToolCallId,
				activity: {
					kind: 'tool-metadata',
					...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
					toolName: event.toolName,
					title: event.title,
					metadata: event.metadata,
				},
			},
		];
	});
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
