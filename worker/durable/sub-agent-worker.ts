import { Think } from '@cloudflare/think';

import { DEFAULT_AI_MODEL, MCP_SERVERS } from '@shared/constants';
import { aiModelSchema } from '@shared/validation';

import { filesystemNamespace } from '../lib/durable-object-namespaces';
import { runWithProjectStub } from '../lib/project-fs';
import { toDurableObjectId } from '../lib/project-id';
import { createSendEventFunction } from '../services/agent/event-helpers';
import { callConfiguredMcpTool, registerConfiguredMcpServers } from '../services/agent/mcp';
import { isRequestOriginContext } from '../services/agent/request-origin-context';
import { readAgentsContext } from '../services/agent/system-prompt-builder';
import { createServerTools, SUB_AGENT_EXCLUDED_TOOLS } from '../services/agent/tools';
import { createAdapter as createWorkersAiAdapter } from '../services/agent/workers-ai';

import type { RequestOriginContext } from '../services/agent/request-origin-context';
import type { ChatResponseResult, ChunkContext, TurnConfig, TurnContext } from '@cloudflare/think';
import type { StreamEvent } from '@shared/agent-state';
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
}

interface SubAgentState {
	input?: SubAgentInput;
}

export class SubAgentWorker extends Think<Env, SubAgentState> {
	initialState: SubAgentState = {};
	chatStreamStallTimeoutMs = 120_000;
	maxSteps = 100;
	exposeMcpTools = false;
	private eventQueue: StreamEvent[] = [];
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
		this.setState({ input });
		return {
			id: crypto.randomUUID(),
			role: 'user',
			parts: [{ type: 'text', text: input.prompt }],
		};
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
		const instructions = agentsContext
			? `${SUB_AGENT_SYSTEM_PROMPT}\n\n## Project Guidelines (from AGENTS.md)\n${agentsContext}`
			: SUB_AGENT_SYSTEM_PROMPT;
		this.eventQueue = [];
		this.eventAbortController.abort();
		this.eventAbortController = new AbortController();
		const sendEvent = createSendEventFunction(this.eventQueue, { current: undefined }, this.eventAbortController.signal);
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
			model: createWorkersAiAdapter(input.model, {
				generationType: 'agent',
				projectId: input.projectId,
				organizationId: input.organizationId,
			}),
			instructions,
			tools,
			maxSteps: this.maxSteps,
			chatStreamStallTimeoutMs: this.chatStreamStallTimeoutMs,
			maxRetries: 0,
		};
	}

	override async onChunk(_context: ChunkContext): Promise<void> {
		await this.forwardParentEvents();
	}

	override async onChatResponse(_result: ChatResponseResult): Promise<void> {
		await this.forwardParentEvents();
	}

	private async forwardParentEvents(): Promise<void> {
		const events = buildSubAgentParentEvents(this.eventQueue, this.state.input?.parentToolCallId);
		this.eventQueue = [];
		if (events.length === 0) return;

		const { SessionTurnAgent } = await import('./session-turn-agent');
		const parent = await this.parentAgent(SessionTurnAgent);
		await parent.receiveSubAgentEvents(events);
	}
}

export function buildSubAgentParentEvents(events: StreamEvent[], parentToolCallId?: string): StreamEvent[] {
	return events.flatMap<StreamEvent>((event) => {
		if (event.type === 'file-changed') return [event];
		if (event.type !== 'tool-result' || !parentToolCallId) return [];
		return [
			{
				type: 'sub-agent-activity',
				parentToolCallId,
				activity: { kind: 'tool-metadata', toolName: event.toolName, title: event.title, metadata: event.metadata },
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
		parentToolCallId: 'parentToolCallId' in value && typeof value.parentToolCallId === 'string' ? value.parentToolCallId : undefined,
	};
}
