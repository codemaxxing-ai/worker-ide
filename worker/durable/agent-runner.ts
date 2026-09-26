import { ExtensionManager } from '@cloudflare/think/extensions';
import { Agent, callable, getCurrentAgent } from 'agents';
import { AgentSearchProvider, SessionManager } from 'agents/experimental/memory/session';
import { createCompactFunction } from 'agents/experimental/memory/utils';
import { generateText } from 'ai';
import { env } from 'cloudflare:workers';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import { messagePartsHaveUserContent, messagePartsToPromptText } from '@shared/chat-message-parts';
import {
	AGENT_SYSTEM_PROMPT,
	DEFAULT_AI_MODEL,
	MAX_AI_SESSIONS_PER_PROJECT,
	MCP_SERVERS,
	SUMMARIZATION_AI_MODEL,
	getModelConfig,
} from '@shared/constants';
import { buildProjectDeepLinkPath } from '@shared/project-deep-link';
import {
	pendingChangesFileSchema,
	reviewHunkUpdateSchema,
	reviewResolveManySchema,
	reviewResolveSchema,
	sessionTitleSchema,
} from '@shared/validation';
import { runWithProjectStub } from '@worker/lib/project-fs';

import {
	buildLoadedExtensionsSummary,
	reattachForkedMessageState,
	restoreExtensionManager,
	runSessionSearch,
} from './agent-runner-helpers';
import { getUserMessagePromptText, sanitizeSubmittedUserMessageParts } from './agent-runner-input';
import {
	getParticipantColor,
	getParticipantProfile,
	isConnectionIdentityAttachment,
	type ConnectionIdentityAttachment,
} from './agent-runner-presence';
import { AgentTurnCoordinator } from './agent-turn-coordinator';
import {
	deleteSessionMetadata,
	getDatabase,
	readPendingChangesData,
	updateSessionMetadataTitleGenerated,
	upsertSessionMetadata,
	writePendingChangesData,
} from './db';
import { AgentSessionStore } from './session-store';
import { SessionStreamState } from './session-stream-state';
import { SessionTurnAgent } from './session-turn-agent';
import * as authSchema from '../db/auth-schema';
import { trackWebSocketEvent } from '../lib/analytics';
import { filesystemNamespace } from '../lib/durable-object-namespaces';
import { toDurableObjectId } from '../lib/project-id';
import { chatMessagesToModelMessages, estimateMessagesTokens, estimateSessionTokens } from '../services/agent/context-pruner';
import { registerConfiguredMcpServers } from '../services/agent/mcp';
import { ARTIFACTS_CONTEXT_LABEL, HISTORY_CONTEXT_LABEL, ROOT_MEMORY_CONTEXT_LABEL } from '../services/agent/memory/artifacts';
import { SharedContextProvider } from '../services/agent/memory/shared-context-provider';
import { isRequestOriginContext } from '../services/agent/request-origin-context';
import { ReviewQueueStore } from '../services/agent/review-queue';
import { cleanupSessionArtifacts } from '../services/agent/session-cleanup';
import { sessionMessagesToChatMessages } from '../services/agent/session-messages';
import { readAgentsContext } from '../services/agent/system-prompt-builder';
import { deriveFallbackTitle, generateSessionTitle } from '../services/agent/title-generator';
import { createAdapter as createWorkersAiAdapter } from '../services/agent/workers-ai';

import type { AgentDatabase } from './db';
import type { RequestOriginContext } from '../services/agent/request-origin-context';
import type { AgentRunnerClient, StartRunRequest, SubmitMessageRequest } from '@shared/agent-rpc';
import type { AgentState, AgentSessionState, SessionParticipantProfile, SessionSummary, StreamEvent } from '@shared/agent-state';
import type { AIModelId } from '@shared/constants';
import type { PushNotification } from '@shared/notification-types';
import type { AgentMode, AiSession, ChatMessage, PendingFileChange, ReviewEntry, UserMessagePart } from '@shared/types';

const REQUEST_ORIGIN_CONTEXT_STORAGE_KEY = 'request-origin-context';
const SESSION_COMPACTION_THRESHOLD = 100_000;
const SESSION_COMPACTION_PROTECT_HEAD = 3;
const SESSION_COMPACTION_TAIL_TOKEN_BUDGET = 32_000;
const SESSION_COMPACTION_MIN_TAIL_MESSAGES = 4;

const ROOT_MEMORY_MAX_TOKENS = 2000;
const PROJECT_ROOT = '/project';
const MAX_SESSIONS = MAX_AI_SESSIONS_PER_PROJECT;

type AgentConnection = import('agents').Connection<unknown>;

export class AgentRunner extends Agent<Env, AgentState> implements AgentRunnerClient {
	// The instance name (agent:<projectId>) is not sensitive — explicitly opt in
	// to sending it on connect so the SDK doesn't log a warning on every connection.
	static options = { sendIdentityOnConnect: true };

	// ---- Agents SDK State ----

	initialState: AgentState = {
		currentSession: undefined,
		sessions: [],
		sessionParticipants: {},
		reviewEntries: {},
		reviewSummary: { unresolvedCount: 0, reviewVersion: 0, sessionCounts: {} },
	};

	// ---- Drizzle database instance (initialized in onStart) ----

	private db!: AgentDatabase;
	private agentSessionStore!: AgentSessionStore;
	private reviewQueue!: ReviewQueueStore;
	private extensionManager?: ExtensionManager;
	private reviewVersion = 0;
	private rootMemoryProvider = new SharedContextProvider(this, ROOT_MEMORY_CONTEXT_LABEL);
	private artifactsProvider = new AgentSearchProvider(this);
	private artifactsContextProvider = {
		init: (label: string) => {
			this.artifactsProvider.init(label);
		},
		get: async () => this.artifactsProvider.get(),
		search: async (query: string) => this.artifactsProvider.search(query),
	};
	private sessionManager = SessionManager.create(this)
		.withContext('soul', {
			provider: {
				get: async () => this.getSoulPrompt(),
			},
		})
		.withContext(ROOT_MEMORY_CONTEXT_LABEL, {
			description: 'Important facts about this project learned across sessions.',
			maxTokens: ROOT_MEMORY_MAX_TOKENS,
			provider: this.rootMemoryProvider,
		})
		.withContext(ARTIFACTS_CONTEXT_LABEL, {
			description: 'Searchable project artifacts such as plans, todos, diagnostics, and sub-agent reports.',
			provider: this.artifactsContextProvider,
		})
		.onCompaction(
			createCompactFunction({
				summarize: async (prompt) => {
					const { text } = await generateText({
						model: createWorkersAiAdapter(SUMMARIZATION_AI_MODEL, {
							generationType: 'compaction',
							projectId: this.getProjectId(),
							organizationId: this.projectOrganizationId,
							repeatedContextKey: prompt,
						}),
						prompt,
						maxOutputTokens: 4096,
					});
					return text;
				},
				protectHead: SESSION_COMPACTION_PROTECT_HEAD,
				tailTokenBudget: SESSION_COMPACTION_TAIL_TOKEN_BUDGET,
				minTailMessages: SESSION_COMPACTION_MIN_TAIL_MESSAGES,
			}),
		)
		.compactAfter(SESSION_COMPACTION_THRESHOLD, {
			// Drive BOTH the compaction trigger and the boundary ("what to
			// compress") decision off the same accurate char-heuristic estimate
			// the rest of the agent uses, instead of the SDK's default estimate.
			tokenCounter: ({ messages, systemPrompt }) => estimateSessionTokens(messages, systemPrompt),
		})
		.withCachedPrompt()
		.withSearchableHistory(HISTORY_CONTEXT_LABEL);

	// ---- Volatile in-memory state (lost on eviction) ----
	private titleGenerationInFlight = new Set<string>();
	private projectOrganizationId?: string;
	private sessionStreamState = new SessionStreamState({
		getCurrentSession: () => this.state.currentSession,
		updateSessionState: (sessionId, patch) => this.updateSessionState(sessionId, patch),
		readSession: (sessionId) => this.agentSessionStore.read(sessionId),
		getSessionInitiatorUserId: (sessionId) => this.sessionInitiatorUserIds.get(sessionId),
		sendPushNotification: (userId, notification) => this.sendPushNotification(userId, notification),
		recordToolCall: (sessionId) => {
			const analytics = this.sessionAnalytics.get(sessionId);
			if (analytics) {
				analytics.toolCallCount += 1;
			}
		},
		recordTurnComplete: (sessionId) => {
			const analytics = this.sessionAnalytics.get(sessionId);
			if (analytics) {
				analytics.turnNumber += 1;
			}
		},
		recordUsage: (sessionId, inputTokens, outputTokens) => {
			const analytics = this.sessionAnalytics.get(sessionId);
			if (analytics) {
				analytics.inputTokens = inputTokens;
				analytics.outputTokens = outputTokens;
			}
		},
	});
	private sessionInitiatorUserIds = new Map<string, string>();
	private requestOriginContext?: RequestOriginContext;
	private turnCoordinator = new AgentTurnCoordinator({
		getCurrentSession: () => this.state.currentSession,
		updateSessionState: (sessionId, patch) => this.updateSessionState(sessionId, patch),
		getConfiguredTurnAgent: (sessionId, model) => this.getSessionTurnAgent(sessionId, model),
		getTurnAgent: (sessionId) => this.subAgent(SessionTurnAgent, sessionId),
		getSessionStore: () => this.agentSessionStore,
		getReviewQueue: () => this.reviewQueue,
		refreshReviewState: () => this.refreshReviewState(),
		refreshSessionsList: () => this.refreshSessionsList(),
		hasCompletion: (sessionId, submissionId) =>
			this.sql<{ submissionId: string }>`
				SELECT submission_id as submissionId
				FROM think_turn_completions
				WHERE session_id = ${sessionId} AND submission_id = ${submissionId}
				LIMIT 1
			`[0] !== undefined,
		markCompletion: (sessionId, submissionId) => {
			this.sql`
				INSERT OR IGNORE INTO think_turn_completions (session_id, submission_id, completed_at)
				VALUES (${sessionId}, ${submissionId}, ${Date.now()})
			`;
		},
		pruneOldSessions: () => this.pruneOldSessions(this.getProjectId()),
	});
	private sessionAnalytics = new Map<
		string,
		{ inputTokens: number; outputTokens: number; durationMs: number; toolCallCount: number; turnNumber: number }
	>();

	// =========================================================================
	// State Validation
	// =========================================================================

	/**
	 * Validate structural invariants before state is persisted and broadcast.
	 * Runs synchronously — throwing rejects the update.
	 */
	validateStateChange(nextState: AgentState): void {
		if (nextState.currentSession !== undefined) {
			const session = nextState.currentSession;
			if (!session.sessionId) {
				throw new Error('AgentSessionState requires a non-empty sessionId');
			}
			if (!Array.isArray(session.messages)) {
				throw new TypeError('AgentSessionState.messages must be an array');
			}
			if (typeof session.contextTokensUsed !== 'number' || session.contextTokensUsed < 0) {
				throw new Error('AgentSessionState.contextTokensUsed must be a non-negative number');
			}
		}
		if (!Array.isArray(nextState.sessions)) {
			throw new TypeError('AgentState.sessions must be an array');
		}
		if (
			typeof nextState.sessionParticipants !== 'object' ||
			Array.isArray(nextState.sessionParticipants) ||
			!nextState.sessionParticipants
		) {
			throw new TypeError('AgentState.sessionParticipants must be an object');
		}
	}

	// =========================================================================
	// WebSocket Lifecycle
	// =========================================================================

	/**
	 * Called by the Agents SDK when a new WebSocket connection is established.
	 * Extracts the authenticated userId forwarded by the main Worker and stores
	 * the resolved user identity in the WebSocket attachment so it survives
	 * hibernation and can be read back from @callable methods.
	 */
	async onConnect(connection: AgentConnection, context: import('agents').ConnectionContext): Promise<void> {
		await super.onConnect(connection, context);
		const userId = context.request?.headers.get('x-worker-ide-user-id');
		const baseDomain = context.request?.headers.get('x-worker-ide-base-domain');
		const protocol = context.request?.headers.get('x-worker-ide-protocol');
		if (userId) {
			const identity = await this.loadConnectionIdentity(userId);
			connection.serializeAttachment(identity);
			this.setSessionParticipants({
				...this.state.sessionParticipants,
				[identity.userId]: getParticipantProfile(identity),
			});
		}
		if (baseDomain && protocol) {
			this.persistRequestOriginContext({ baseDomain, protocol });
		}
		if (this.state.currentSession) {
			await this.syncStateSessionParticipants(this.state.currentSession.messages);
		}

		trackWebSocketEvent({
			projectId: this.ctx.id.toString(),
			eventType: 'connect',
			connectionType: 'agent',
			userId: userId ?? undefined,
			concurrentConnections: this.getConnectedConnectionCount(),
		});
	}

	onClose(_connection: AgentConnection): void {
		trackWebSocketEvent({
			projectId: this.ctx.id.toString(),
			eventType: 'disconnect',
			connectionType: 'agent',
			concurrentConnections: this.getConnectedConnectionCount(),
		});
	}

	private getConnectionIdentity(connection: WebSocket | AgentConnection | undefined): ConnectionIdentityAttachment | undefined {
		if (!connection) {
			return undefined;
		}

		try {
			const attachment: unknown = connection.deserializeAttachment();
			return isConnectionIdentityAttachment(attachment) ? attachment : undefined;
		} catch {
			return undefined;
		}
	}

	private getCurrentCallerIdentity(): ConnectionIdentityAttachment | undefined {
		return this.getConnectionIdentity(getCurrentAgent().connection);
	}

	private getConnectedConnectionCount(): number {
		let count = 0;
		for (const connection of this.ctx.getWebSockets()) {
			if (connection.readyState === WebSocket.OPEN && this.getConnectionIdentity(connection)) {
				count += 1;
			}
		}
		return count;
	}

	private getLiveConnectionParticipants(): Record<string, SessionParticipantProfile> {
		const participants: Record<string, SessionParticipantProfile> = {};
		for (const connection of this.ctx.getWebSockets()) {
			if (connection.readyState !== WebSocket.OPEN) {
				continue;
			}
			const identity = this.getConnectionIdentity(connection);
			if (identity) {
				participants[identity.userId] = getParticipantProfile(identity);
			}
		}
		return participants;
	}

	private setSessionParticipants(sessionParticipants: Record<string, SessionParticipantProfile>): void {
		if (this.state.sessionParticipants === sessionParticipants) {
			return;
		}

		this.setState({
			...this.state,
			sessionParticipants,
		});
	}

	private async loadConnectionIdentity(userId: string): Promise<ConnectionIdentityAttachment> {
		// Failures here must never reject the WebSocket handshake — fall back to a
		// minimal identity so the connection still succeeds. The worst case is a
		// participant displayed as "Unknown" until their profile is refreshed.
		try {
			const database = drizzle(env.DB, { schema: authSchema });
			const userRows = await database
				.select({ name: authSchema.user.name, image: authSchema.user.image })
				.from(authSchema.user)
				.where(eq(authSchema.user.id, userId))
				.limit(1);

			return {
				userId,
				name: userRows[0]?.name ?? 'Unknown',
				image: userRows[0]?.image ?? undefined,
				color: getParticipantColor(userId),
			};
		} catch (error) {
			console.error('[AgentRunner] Failed to load connection identity from D1:', error);
			return {
				userId,
				name: 'Unknown',
				color: getParticipantColor(userId),
			};
		}
	}

	private async resolveSessionParticipants(messages: readonly ChatMessage[]): Promise<Record<string, SessionParticipantProfile>> {
		const nextParticipants = { ...this.state.sessionParticipants };
		const unresolvedUserIds = new Set<string>();

		for (const message of messages) {
			if (!message.authorUserId || nextParticipants[message.authorUserId]) {
				continue;
			}

			const liveIdentity = [...this.ctx.getWebSockets()]
				.map((connection) => this.getConnectionIdentity(connection))
				.find((identity) => identity?.userId === message.authorUserId);
			if (liveIdentity) {
				nextParticipants[liveIdentity.userId] = getParticipantProfile(liveIdentity);
				continue;
			}

			unresolvedUserIds.add(message.authorUserId);
		}

		const missingUserIds = [...unresolvedUserIds];
		if (missingUserIds.length > 0) {
			const database = drizzle(env.DB, { schema: authSchema });
			const userRows = await database
				.select({ id: authSchema.user.id, name: authSchema.user.name, image: authSchema.user.image })
				.from(authSchema.user)
				.where(inArray(authSchema.user.id, missingUserIds));

			for (const userRow of userRows) {
				nextParticipants[userRow.id] = {
					name: userRow.name,
					image: userRow.image ?? undefined,
					color: getParticipantColor(userRow.id),
				};
			}

			for (const userId of missingUserIds) {
				if (nextParticipants[userId]) {
					continue;
				}

				nextParticipants[userId] = {
					name: 'Unknown',
					color: getParticipantColor(userId),
				};
			}
		}

		return nextParticipants;
	}

	private async syncStateSessionParticipants(messages: readonly ChatMessage[]): Promise<Record<string, SessionParticipantProfile>> {
		const sessionParticipants = await this.resolveSessionParticipants(messages);
		this.setSessionParticipants(sessionParticipants);
		return sessionParticipants;
	}

	private persistRequestOriginContext(context: RequestOriginContext): void {
		this.requestOriginContext = context;
		this.ctx.storage.kv.put(REQUEST_ORIGIN_CONTEXT_STORAGE_KEY, context);
	}

	private resolveProjectIdFromRequest(request: Request): string {
		const roomName = request.headers.get('x-partykit-room');
		if (roomName?.startsWith('agent:')) {
			return roomName.slice(6);
		}
		return this.getProjectId();
	}

	// =========================================================================
	// HTTP Request Handler
	// =========================================================================

	async onRequest(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const projectId = this.resolveProjectIdFromRequest(request);

		if (url.pathname === '/pending-changes') {
			if (request.method === 'GET') {
				return Response.json(this.loadPendingChangesFromDatabase());
			}
			if (request.method === 'PUT') {
				const body: unknown = await request.json();
				const parsed = pendingChangesFileSchema.safeParse(body);
				if (!parsed.success) {
					return Response.json(
						{ error: 'Invalid pending changes' },
						{
							status: 400,
							headers: { 'Content-Type': 'application/json' },
						},
					);
				}
				this.savePendingChangesToDatabase(parsed.data);
				this.reviewQueue.bootstrapLegacyPendingChanges(parsed.data);
				this.refreshReviewState();
				return new Response(undefined, { status: 204 });
			}
		}

		if (url.pathname === '/review' && request.method === 'GET') {
			return Response.json({ entries: this.reviewQueue.listReviewEntries() });
		}

		if (url.pathname === '/review/resolve-many' && request.method === 'POST') {
			const body: unknown = await request.json();
			const parsed = reviewResolveManySchema.safeParse(body);
			if (!parsed.success) {
				return Response.json({ error: 'Invalid review resolution' }, { status: 400, headers: { 'Content-Type': 'application/json' } });
			}
			await this.withProjectMount(async () => {
				await this.reviewQueue.resolveEntries(
					PROJECT_ROOT,
					projectId,
					parsed.data.decision,
					parsed.data.sessionId,
					parsed.data.reviewIds,
					parsed.data.liveContents,
				);
			}, projectId);
			this.refreshReviewState();
			return new Response(undefined, { status: 204 });
		}

		const reviewMatch = url.pathname.match(/^\/review\/([^/]+)\/(hunks|resolve)$/);
		if (reviewMatch) {
			const [, reviewId, action] = reviewMatch;
			if (!reviewId || !action) {
				return new Response('Not Found', { status: 404 });
			}
			if (action === 'hunks' && request.method === 'PUT') {
				const body: unknown = await request.json();
				const parsed = reviewHunkUpdateSchema.safeParse(body);
				if (!parsed.success) {
					return Response.json({ error: 'Invalid hunk update' }, { status: 400, headers: { 'Content-Type': 'application/json' } });
				}
				await this.withProjectMount(async () => {
					await this.reviewQueue.updateHunkStatuses(PROJECT_ROOT, projectId, reviewId, parsed.data.hunkStatuses, parsed.data.liveContent);
				}, projectId);
				this.refreshReviewState();
				return new Response(undefined, { status: 204 });
			}
			if (action === 'resolve' && request.method === 'POST') {
				const body: unknown = await request.json();
				const parsed = reviewResolveSchema.safeParse(body);
				if (!parsed.success) {
					return Response.json({ error: 'Invalid review resolution' }, { status: 400, headers: { 'Content-Type': 'application/json' } });
				}
				await this.withProjectMount(async () => {
					await this.reviewQueue.resolveEntry(PROJECT_ROOT, projectId, reviewId, parsed.data.decision, parsed.data.liveContent);
				}, projectId);
				this.refreshReviewState();
				return new Response(undefined, { status: 204 });
			}
		}

		if (url.pathname === '/review/sync-path' && request.method === 'POST') {
			const body: unknown = await request.json();
			const path = typeof body === 'object' && body && 'path' in body && typeof body.path === 'string' ? body.path : undefined;
			if (!path) {
				return Response.json({ error: 'Invalid path sync' }, { status: 400, headers: { 'Content-Type': 'application/json' } });
			}
			await this.withProjectMount(async () => {
				await this.reviewQueue.syncTrackedPathFromWorkspace(PROJECT_ROOT, path);
			}, projectId);
			this.refreshReviewState();
			return new Response(undefined, { status: 204 });
		}

		if (url.pathname === '/review/move-path' && request.method === 'POST') {
			const body: unknown = await request.json();
			const fromPath =
				typeof body === 'object' && body && 'fromPath' in body && typeof body.fromPath === 'string' ? body.fromPath : undefined;
			const toPath = typeof body === 'object' && body && 'toPath' in body && typeof body.toPath === 'string' ? body.toPath : undefined;
			if (!fromPath || !toPath) {
				return Response.json({ error: 'Invalid move sync' }, { status: 400, headers: { 'Content-Type': 'application/json' } });
			}
			this.reviewQueue.moveTrackedPath(fromPath, toPath);
			this.refreshReviewState();
			return new Response(undefined, { status: 204 });
		}

		return new Response('Not Found', { status: 404 });
	}

	// =========================================================================
	// Lifecycle
	// =========================================================================

	/**
	 * Called when the Agent starts (or wakes from hibernation / eviction).
	 * Initializes storage-backed helpers and restores extensions.
	 */
	async onStart(): Promise<void> {
		// MIGRATION: ensure sessionParticipants is an object
		if (!this.state.sessionParticipants || typeof this.state.sessionParticipants !== 'object') {
			this.setState({ ...this.state, sessionParticipants: {} });
		}

		this.db = getDatabase(this.ctx.storage);
		await registerConfiguredMcpServers(this).catch((error) => {
			console.error(
				`[AgentRunner] Failed to connect configured MCP servers (${MCP_SERVERS.map((server) => server.id).join(', ')}):`,
				error,
			);
		});
		this.agentSessionStore = new AgentSessionStore(this.db, this.sessionManager);
		this.ensureAgentDatabaseTables();
		this.reviewQueue = new ReviewQueueStore(this.db);
		this.reviewQueue.bootstrapLegacyPendingChanges(this.loadPendingChangesFromDatabase());
		this.extensionManager = await restoreExtensionManager(env.LOADER, this.ctx.storage);
		this.projectOrganizationId = await this.lookupProjectOrganizationId(this.getProjectId());
		const persistedRequestOriginContext = this.ctx.storage.kv.get<RequestOriginContext>(REQUEST_ORIGIN_CONTEXT_STORAGE_KEY);
		this.requestOriginContext = isRequestOriginContext(persistedRequestOriginContext) ? persistedRequestOriginContext : undefined;
		this.refreshReviewState();
		await this.refreshSessionsList();
	}

	private async getSoulPrompt(): Promise<string> {
		const agentsContext = await readAgentsContext(PROJECT_ROOT);
		if (!agentsContext) {
			return AGENT_SYSTEM_PROMPT;
		}

		return `${AGENT_SYSTEM_PROMPT}\n\n## Project Guidelines (from AGENTS.md)\n${agentsContext}`;
	}

	// =========================================================================
	// @callable RPC Methods (invoked by clients via WebSocket)
	// =========================================================================

	@callable()
	async submitMessage(request: SubmitMessageRequest): Promise<{ sessionId: string; queued: boolean; started: boolean }> {
		const projectId = this.getProjectId();
		const mode = request.mode ?? 'code';
		const model = request.model ?? DEFAULT_AI_MODEL;
		const sanitizedParts = sanitizeSubmittedUserMessageParts(request.parts);
		if (!messagePartsHaveUserContent(sanitizedParts)) {
			throw new Error('Message is required.');
		}

		const promptText = getUserMessagePromptText(sanitizedParts);

		const resolvedSessionId = request.sessionId ?? crypto.randomUUID().replaceAll('-', '').slice(0, 16);

		return this.turnCoordinator.withSessionMutationLock(resolvedSessionId, async () => {
			const callerIdentity = this.getCurrentCallerIdentity();
			const authenticatedUserId = callerIdentity?.userId;
			if (callerIdentity) {
				this.setSessionParticipants({
					...this.state.sessionParticipants,
					[callerIdentity.userId]: getParticipantProfile(callerIdentity),
				});
			}

			const current = this.state.currentSession;
			const shouldQueue = current?.sessionId === resolvedSessionId && current.status === 'running';
			const userMessage = this.buildUserMessage(
				sanitizedParts,
				mode,
				model,
				shouldQueue ? 'queued' : 'committed',
				authenticatedUserId,
				request.messageId,
				request.createdAt,
			);
			this.ensureSessionRecord(resolvedSessionId, deriveFallbackTitle(promptText, 80), model, mode);
			if (!this.agentSessionStore.getMetadata(resolvedSessionId).titleGenerated) {
				void this.generateTitle(resolvedSessionId, promptText);
			}
			if (authenticatedUserId) this.sessionInitiatorUserIds.set(resolvedSessionId, authenticatedUserId);

			if (env.AI_RATE_LIMITER) {
				const { success } = await env.AI_RATE_LIMITER.limit({ key: projectId });
				if (!success) throw new Error('Rate limit exceeded. Please wait before making more AI requests.');
			}

			return this.turnCoordinator.submitMessage(
				resolvedSessionId,
				userMessage,
				model,
				{
					mode,
					model,
					initiatorUserId: authenticatedUserId,
					requestOriginContext: this.requestOriginContext,
				},
				current,
			);
		});
	}

	@callable()
	async removeQueuedMessage(sessionId: string, messageId: string): Promise<{ removed: boolean }> {
		const callerIdentity = this.getCurrentCallerIdentity();

		return this.turnCoordinator.withSessionMutationLock(sessionId, () =>
			this.turnCoordinator.removeQueuedMessage(sessionId, messageId, callerIdentity?.userId),
		);
	}

	@callable()
	async startRun(request: StartRunRequest): Promise<{ sessionId: string }> {
		const mode = request.mode ?? 'code';
		const model = request.model ?? DEFAULT_AI_MODEL;
		const resolvedSessionId = request.sessionId ?? crypto.randomUUID().replaceAll('-', '').slice(0, 16);

		return this.turnCoordinator.withSessionMutationLock(resolvedSessionId, async () => {
			const callerIdentity = this.getCurrentCallerIdentity();
			const authenticatedUserId = callerIdentity?.userId;
			const normalizedMessages = request.messages.map((message) => {
				if (message.role !== 'user') {
					return message;
				}

				const normalizedParts = sanitizeSubmittedUserMessageParts(message.parts);

				const normalizedMessage: ChatMessage = {
					...message,
					authorUserId: message.authorUserId ?? authenticatedUserId,
					parts: normalizedParts,
					metadata: {
						...message.metadata,
						request: {
							mode: message.metadata?.request?.mode ?? mode,
							model: message.metadata?.request?.model ?? model,
							state: 'committed',
						},
					},
				};

				return normalizedMessage;
			});
			const latestUserIndex = normalizedMessages.findLastIndex((message) => message.role === 'user');
			const latestUserMessage = normalizedMessages[latestUserIndex];
			if (!latestUserMessage || latestUserMessage.role !== 'user') throw new Error('A user message is required to start a run.');

			this.ensureSessionRecord(
				resolvedSessionId,
				deriveFallbackTitle(messagePartsToPromptText(latestUserMessage.parts).trim(), 80),
				model,
				mode,
			);
			if (authenticatedUserId) this.sessionInitiatorUserIds.set(resolvedSessionId, authenticatedUserId);
			if (env.AI_RATE_LIMITER) {
				const { success } = await env.AI_RATE_LIMITER.limit({ key: this.getProjectId() });
				if (!success) throw new Error('Rate limit exceeded. Please wait before making more AI requests.');
			}
			return this.turnCoordinator.startRun(resolvedSessionId, normalizedMessages.slice(0, latestUserIndex), latestUserMessage, model, {
				mode,
				model,
				initiatorUserId: authenticatedUserId,
				requestOriginContext: this.requestOriginContext,
			});
		});
	}

	@callable()
	async abortRun(sessionId?: string): Promise<void> {
		const resolvedSessionId = sessionId ?? this.state.currentSession?.sessionId;
		if (!resolvedSessionId) return;
		await this.turnCoordinator.abortRun(resolvedSessionId);
	}

	/**
	 * Load a session into the current state.
	 *
	 * Note: The returned `AiSession` is always read from the database, so during
	 * an active streaming turn it will be **stale** (missing in-flight messages).
	 * Callers must not rely on the return value for up-to-date message history;
	 * instead, they should consume `agent.state.currentSession` which is kept
	 * current via real-time state sync.
	 */
	@callable()
	async loadSession(sessionId: string): Promise<AiSession | undefined> {
		const session = await this.agentSessionStore.read(sessionId);
		if (!session) return undefined;

		// If this session is already loaded and actively running, don't overwrite
		// the live in-memory state with stale DB data. Mid-turn streaming content
		// (thinking, partial tool calls, in-progress text) only exists in
		// this.state.currentSession.messages and hasn't been persisted to the DB
		// yet (only persisted on turn-complete). Overwriting would lose messages.
		if (this.state.currentSession?.sessionId === sessionId && this.state.currentSession.status === 'running') {
			return session;
		}

		// Update agent state so all clients see the loaded session
		const pendingChangesMap = this.loadPendingChangesFromDatabase();
		const isRunning = this.state.currentSession?.sessionId === sessionId && this.state.currentSession.status === 'running';
		const sessionParticipants = await this.resolveSessionParticipants(session.history);

		this.setState({
			...this.state,
			sessionParticipants,
			currentSession: {
				sessionId,
				title: session.title,
				status: isRunning ? 'running' : (session.status ?? 'idle'),
				messages: [],
				historyVersion: this.state.currentSession?.sessionId === sessionId ? this.state.currentSession.historyVersion : 0,
				statusText: isRunning ? (session.stopRequested ? 'Stopping...' : 'Thinking...') : undefined,
				error: session.errorMessage ? { message: session.errorMessage } : undefined,
				contextTokensUsed: session.contextTokensUsed ?? 0,
				pendingChanges: pendingChangesMap,
				toolMetadata: session.toolMetadata ?? {},
				toolErrors: session.toolErrors ?? {},
				debugLogId: undefined,
				stopRequested: session.stopRequested ?? false,
				pendingQuestion: undefined,
				needsContinuation: false,
				doomLoopMessage: undefined,
				subAgentActivities: {},
				contextBlocksSummary: this.getContextBlocksSummary(sessionId),
				extensions: this.getLoadedExtensionsSummary(),
			},
		});

		return session;
	}
	@callable()
	async listSessions(): Promise<SessionSummary[]> {
		return this.sessionManager
			.list()
			.toSorted((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
			.map((sessionInfo) => ({
				id: sessionInfo.id,
				title: sessionInfo.name,
				createdAt: Date.parse(sessionInfo.created_at),
				isRunning: this.state.currentSession?.sessionId === sessionInfo.id && this.state.currentSession.status === 'running',
			}));
	}

	@callable()
	async searchSessions(query: string, limit = 20): Promise<Array<{ sessionId: string; role: string; content: string }>> {
		return runSessionSearch(query, limit, async (trimmedQuery, resolvedLimit) => {
			const matches = this.sessionManager.search(trimmedQuery, { limit: resolvedLimit });
			const results: Array<{ sessionId: string; role: string; content: string }> = [];
			for (const match of matches) {
				const sessionId = this.lookupSessionIdForMessage(match.id);
				if (!sessionId) {
					continue;
				}
				results.push({ sessionId, role: match.role, content: match.content });
			}
			return results;
		});
	}
	@callable()
	async revertSession(sessionId: string, messageIndex: number): Promise<{ contextTokensUsed: number }> {
		if (messageIndex <= 0) {
			await this.sessionManager.delete(sessionId);
			deleteSessionMetadata(this.db, sessionId);
			this.reviewQueue.removeSession(sessionId);
			this.refreshReviewState();
			// Clear the current session state so the frontend shows an empty chat
			if (this.state.currentSession?.sessionId === sessionId) {
				this.setState({
					...this.state,
					currentSession: undefined,
					sessionParticipants: this.getLiveConnectionParticipants(),
				});
			}
			await this.refreshSessionsList();
			return { contextTokensUsed: 0 };
		}

		const sourceSession = this.sessionManager.get(sessionId);
		if (!sourceSession) return { contextTokensUsed: 0 };
		const sourceHistory = await this.sessionManager.getHistory(sessionId);
		const targetMessage = sourceHistory[messageIndex];
		if (!targetMessage) return { contextTokensUsed: 0 };

		const forkedSession = await this.sessionManager.fork(sessionId, targetMessage.id, `${sourceSession.name} (fork)`);
		const sourceAiSession = await this.agentSessionStore.read(sessionId);
		const forkedHistory = sessionMessagesToChatMessages(await this.sessionManager.getHistory(forkedSession.id));
		const truncatedHistory = reattachForkedMessageState(forkedHistory, sourceAiSession?.history ?? []);
		const sourceMetadata = this.agentSessionStore.getMetadata(sessionId);
		const modelMessages = chatMessagesToModelMessages(truncatedHistory);
		const contextTokensUsed = estimateMessagesTokens(modelMessages);
		await this.agentSessionStore.replaceHistory(forkedSession.id, truncatedHistory);
		upsertSessionMetadata(this.db, {
			id: forkedSession.id,
			titleGenerated: sourceMetadata.titleGenerated ? 1 : 0,
			contextTokensUsed: contextTokensUsed > 0 ? contextTokensUsed : undefined,
			toolMetadata: undefined,
			toolErrors: undefined,
			status: 'idle',
			errorMessage: undefined,
			stopRequested: 0,
		});

		// Filter pending changes: keep entries from other sessions, or from this
		// session only if their snapshotId survives the truncation.
		const survivingSnapshotIds = new Set(
			truncatedHistory
				.map((message) => message.metadata?.snapshotId)
				.filter((snapshotId): snapshotId is string => typeof snapshotId === 'string'),
		);
		const globalChanges = this.loadPendingChangesFromDatabase();
		const survivingSessionChanges: Record<string, PendingFileChange> = {};
		for (const [path, change] of Object.entries(globalChanges)) {
			if (change.sessionId === sessionId && change.snapshotId && survivingSnapshotIds.has(change.snapshotId)) {
				survivingSessionChanges[path] = { ...change, sessionId: forkedSession.id };
			}
		}
		this.reviewQueue.removeSession(sessionId);
		this.reviewQueue.syncSessionPendingChanges(forkedSession.id, survivingSessionChanges);
		this.refreshReviewState();

		// Update state for connected clients
		if (this.state.currentSession?.sessionId === sessionId) {
			const sessionParticipants = await this.resolveSessionParticipants(truncatedHistory);
			this.setState({
				...this.state,
				sessionParticipants,
				currentSession: {
					sessionId: forkedSession.id,
					title: forkedSession.name,
					status: 'idle',
					statusText: undefined,
					error: undefined,
					messages: [],
					historyVersion: this.state.currentSession.historyVersion + 1,
					contextTokensUsed,
					pendingChanges: this.loadPendingChangesFromDatabase(),
					toolMetadata: {},
					toolErrors: {},
					debugLogId: undefined,
					stopRequested: false,
					pendingQuestion: undefined,
					needsContinuation: false,
					doomLoopMessage: undefined,
					subAgentActivities: {},
					contextBlocksSummary: this.getContextBlocksSummary(forkedSession.id),
					extensions: this.getLoadedExtensionsSummary(),
				},
			});
		}

		await this.refreshSessionsList();
		return { contextTokensUsed };
	}
	@callable()
	async renameSession(sessionId: string, title: string): Promise<void> {
		const parsed = sessionTitleSchema.safeParse(title);
		if (!parsed.success) {
			throw new Error(parsed.error.issues[0]?.message ?? 'Invalid title');
		}
		this.sessionManager.rename(sessionId, parsed.data);
		// A manual rename is a deliberate title; mark it settled so the next agent
		// turn's auto title generation does not overwrite the user's choice.
		updateSessionMetadataTitleGenerated(this.db, sessionId, true);

		// Update current session state so all clients see the new title immediately
		if (this.state.currentSession?.sessionId === sessionId) {
			this.updateSessionState(sessionId, { title: parsed.data });
		}

		await this.refreshSessionsList();
	}

	/**
	 * Delete a session and all its associated artifacts.
	 * If the session is running, it is aborted first.
	 */
	@callable()
	async deleteSession(sessionId: string): Promise<void> {
		const projectId = this.getProjectId();
		await this.deleteSubAgent(SessionTurnAgent, sessionId);

		// Clean up all volatile in-memory state for this session
		this.sessionStreamState.disposeSession(sessionId);
		this.sessionInitiatorUserIds.delete(sessionId);
		this.sessionAnalytics.delete(sessionId);
		this.titleGenerationInFlight.delete(sessionId);

		await this.sessionManager.delete(sessionId);
		deleteSessionMetadata(this.db, sessionId);
		this.sql`DELETE FROM think_turn_completions WHERE session_id = ${sessionId}`;
		this.reviewQueue.removeSession(sessionId);
		this.refreshReviewState();
		const survivingSnapshotIds = this.getSurvivingSnapshotIds();

		try {
			const fsId = toDurableObjectId(filesystemNamespace, projectId);
			const fsStub = filesystemNamespace.get(fsId);

			await runWithProjectStub(fsStub, async () => {
				await cleanupSessionArtifacts(PROJECT_ROOT, new Set([sessionId]), survivingSnapshotIds);
			});
		} catch (error) {
			console.error('[AgentRunner] Failed to clean up filesystem artifacts:', error);
		}

		// Clear current session for all clients if this was the active session
		if (this.state.currentSession?.sessionId === sessionId) {
			this.setState({
				...this.state,
				currentSession: undefined,
				sessionParticipants: this.getLiveConnectionParticipants(),
			});
		}

		await this.refreshSessionsList();
	}
	@callable()
	async loadPendingChanges(): Promise<Record<string, PendingFileChange>> {
		return this.loadPendingChangesFromDatabase();
	}
	@callable()
	async savePendingChanges(changes: Record<string, PendingFileChange>): Promise<void> {
		this.savePendingChangesToDatabase(changes);
		this.reviewQueue.bootstrapLegacyPendingChanges(changes);
		this.refreshReviewState();
	}
	@callable()
	async listReviewEntries(): Promise<ReviewEntry[]> {
		return this.reviewQueue.listReviewEntries();
	}
	@callable()
	async updateReviewHunks(reviewId: string, hunkStatuses: PendingFileChange['hunkStatuses']): Promise<void> {
		await this.withProjectMount(async () => {
			await this.reviewQueue.updateHunkStatuses(PROJECT_ROOT, this.getProjectId(), reviewId, hunkStatuses);
		});
		this.refreshReviewState();
	}
	@callable()
	async resolveReviewEntry(reviewId: string, decision: 'accept' | 'reject'): Promise<void> {
		await this.withProjectMount(async () => {
			await this.reviewQueue.resolveEntry(PROJECT_ROOT, this.getProjectId(), reviewId, decision);
		});
		this.refreshReviewState();
	}
	@callable()
	async resolveReviewEntries(decision: 'accept' | 'reject', sessionId?: string, reviewIds?: string[]): Promise<void> {
		await this.withProjectMount(async () => {
			await this.reviewQueue.resolveEntries(PROJECT_ROOT, this.getProjectId(), decision, sessionId, reviewIds);
		});
		this.refreshReviewState();
	}
	@callable()
	async syncReviewPathFromWorkspace(path: string): Promise<void> {
		await this.withProjectMount(async () => {
			await this.reviewQueue.syncTrackedPathFromWorkspace(PROJECT_ROOT, path);
		});
		this.refreshReviewState();
	}
	@callable()
	async moveTrackedReviewPath(fromPath: string, toPath: string): Promise<void> {
		this.reviewQueue.moveTrackedPath(fromPath, toPath);
		this.refreshReviewState();
	}

	/**
	 * Clear the current session state (start fresh).
	 * Aborts any running session first.
	 */
	@callable()
	async clearCurrentSession(sessionId?: string): Promise<void> {
		if (sessionId) {
			const sessionAgent = await this.subAgent(SessionTurnAgent, sessionId);
			await sessionAgent.cancelActiveSubmissions();
		}
		this.setState({
			...this.state,
			currentSession: undefined,
			sessionParticipants: this.getLiveConnectionParticipants(),
		});
	}
	@callable()
	async getRunningSessionIds(): Promise<string[]> {
		const current = this.state.currentSession;
		return current?.status === 'running' ? [current.sessionId] : [];
	}

	async receiveThinkEvents(sessionId: string, events: StreamEvent[]): Promise<void> {
		for (const event of events) {
			await this.sessionStreamState.handleEvent(sessionId, event);
		}
	}

	async beginThinkTurn(sessionId: string, submissionId: string): Promise<void> {
		this.turnCoordinator.beginThinkTurn(sessionId, submissionId);
	}

	async completeThinkTurn(
		sessionId: string,
		submissionId: string,
		history: ChatMessage[],
		status: 'completed' | 'error' | 'aborted',
		error?: string,
		activeSubmissions: Array<{ submissionId: string; status: 'pending' | 'running' }> = [],
	): Promise<void> {
		await this.turnCoordinator.completeThinkTurn(sessionId, submissionId, history, status, error, activeSubmissions);
	}

	// =========================================================================
	// Title Generation
	// =========================================================================

	private async generateTitle(sessionId: string, userText: string): Promise<void> {
		if (this.titleGenerationInFlight.has(sessionId)) return;
		this.titleGenerationInFlight.add(sessionId);

		try {
			const result = await generateSessionTitle(userText, {
				projectId: this.getProjectId(),
				organizationId: this.projectOrganizationId,
			});

			this.sessionManager.rename(sessionId, result.title);
			// Mark the title settled after this attempt regardless of whether the
			// model produced it or we fell back to the prompt preview. Otherwise a
			// fallback (isAiGenerated === false) leaves the flag unset and every
			// subsequent turn re-derives and renames the session from that turn's
			// message — the "title changes constantly" churn.
			updateSessionMetadataTitleGenerated(this.db, sessionId, true);

			// Update state if this is the current session
			if (this.state.currentSession?.sessionId === sessionId) {
				this.updateSessionState(sessionId, { title: result.title });
			}

			// Refresh sessions list
			await this.refreshSessionsList();
		} catch {
			// Non-fatal
		} finally {
			this.titleGenerationInFlight.delete(sessionId);
		}
	}

	// =========================================================================
	// Session Pruning
	// =========================================================================

	private async pruneOldSessions(projectId: string): Promise<void> {
		const allSessions = this.sessionManager
			.list()
			.toSorted((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
			.map((sessionInfo) => ({ id: sessionInfo.id, createdAt: Date.parse(sessionInfo.created_at) }));

		if (allSessions.length <= MAX_SESSIONS) return;

		const runningSessionId = this.state.currentSession?.status === 'running' ? this.state.currentSession.sessionId : undefined;

		const sessionsToPrune: string[] = [];
		for (const session of allSessions.slice(MAX_SESSIONS)) {
			if (session.id !== runningSessionId) {
				sessionsToPrune.push(session.id);
			}
		}

		if (sessionsToPrune.length === 0) return;

		const prunedIds = new Set(sessionsToPrune);

		// Delete from DB
		for (const id of sessionsToPrune) {
			await this.sessionManager.delete(id);
			deleteSessionMetadata(this.db, id);
			this.reviewQueue.removeSession(id);
		}

		this.refreshReviewState();
		const survivingSnapshotIds = this.getSurvivingSnapshotIds();

		// Clean up filesystem artifacts
		try {
			const fsId = toDurableObjectId(filesystemNamespace, projectId);
			const fsStub = filesystemNamespace.get(fsId);

			await runWithProjectStub(fsStub, async () => {
				await cleanupSessionArtifacts(PROJECT_ROOT, prunedIds, survivingSnapshotIds);
			});
		} catch (error) {
			console.error('[AgentRunner] Filesystem cleanup failed:', error);
		}
	}

	// =========================================================================
	// State Helpers
	// =========================================================================
	private updateSessionState(sessionId: string, patch: Partial<AgentSessionState>): void {
		const current = this.state.currentSession;
		if (!current || current.sessionId !== sessionId) {
			// Create a new session state if none exists for this ID. Session
			// history is loaded asynchronously elsewhere; here we only seed
			// synchronously-available metadata and rely on the patch (and later
			// turn-complete syncs) to fill in messages.
			const sessionInfo = this.sessionManager.get(sessionId);
			const metadata = this.agentSessionStore.getMetadata(sessionId);
			const newState: AgentSessionState = {
				sessionId,
				title: sessionInfo?.name ?? 'New session',
				status: 'idle',
				messages: [],
				historyVersion: 0,
				statusText: undefined,
				error: undefined,
				contextTokensUsed: metadata.contextTokensUsed ?? 0,
				pendingChanges: this.loadPendingChangesFromDatabase(),
				toolMetadata: metadata.toolMetadata ?? {},
				toolErrors: metadata.toolErrors ?? {},
				debugLogId: undefined,
				stopRequested: metadata.stopRequested ?? false,
				pendingQuestion: undefined,
				needsContinuation: false,
				doomLoopMessage: undefined,
				subAgentActivities: {},
				contextBlocksSummary: this.getContextBlocksSummary(sessionId),
				extensions: this.getLoadedExtensionsSummary(),
				...patch,
			};
			this.setState({ ...this.state, currentSession: newState });
			return;
		}

		this.setState({
			...this.state,
			currentSession: { ...current, ...patch },
		});
	}
	private async refreshSessionsList(): Promise<void> {
		const sessionsList = await this.listSessions();
		this.setState({ ...this.state, sessions: sessionsList });
	}

	private refreshReviewState(): void {
		this.reviewVersion = Date.now();
		this.setState({
			...this.state,
			reviewEntries: this.reviewQueue.listReviewEntriesRecord(),
			reviewSummary: this.reviewQueue.getReviewSummary(this.reviewVersion),
			currentSession: this.state.currentSession
				? {
						...this.state.currentSession,
						pendingChanges: this.loadPendingChangesFromDatabase(),
					}
				: undefined,
		});
	}

	private ensureAgentDatabaseTables(): void {
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS pending_changes (
				id INTEGER PRIMARY KEY NOT NULL DEFAULT 1,
				data TEXT DEFAULT '{}' NOT NULL
			)
		`);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS session_metadata (
				id TEXT PRIMARY KEY NOT NULL,
				title_generated INTEGER DEFAULT 0 NOT NULL,
				context_tokens_used INTEGER,
				tool_metadata TEXT,
				tool_errors TEXT,
				status TEXT,
				error_message TEXT,
				stop_requested INTEGER DEFAULT 0 NOT NULL
			)
		`);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS session_message_metadata (
				session_id TEXT NOT NULL,
				message_id TEXT NOT NULL,
				request_mode TEXT,
				request_model TEXT,
				request_state TEXT,
				author_user_id TEXT,
				parts_json TEXT,
				snapshot_id TEXT,
				PRIMARY KEY(session_id, message_id)
			)
		`);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS think_turn_completions (
				session_id TEXT NOT NULL,
				submission_id TEXT NOT NULL,
				completed_at INTEGER NOT NULL,
				PRIMARY KEY(session_id, submission_id)
			)
		`);
		try {
			this.ctx.storage.sql.exec('ALTER TABLE session_message_metadata ADD COLUMN parts_json TEXT');
		} catch {
			// Column already exists.
		}
		try {
			this.ctx.storage.sql.exec('ALTER TABLE session_message_metadata ADD COLUMN author_user_id TEXT');
		} catch {
			// Column already exists.
		}
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS session_pending_changes (
				session_id TEXT PRIMARY KEY NOT NULL,
				data TEXT DEFAULT '{}' NOT NULL
			)
		`);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS session_pending_change_index (
				session_id TEXT NOT NULL,
				path TEXT NOT NULL,
				updated_at INTEGER NOT NULL,
				latest_change_set_id TEXT,
				PRIMARY KEY(session_id, path)
			)
		`);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS change_sets (
				id TEXT PRIMARY KEY NOT NULL,
				session_id TEXT NOT NULL,
				snapshot_id TEXT,
				created_at INTEGER NOT NULL
			)
		`);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS change_set_files (
				change_set_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				path TEXT NOT NULL,
				action TEXT NOT NULL,
				before_content TEXT,
				after_content TEXT,
				snapshot_id TEXT,
				PRIMARY KEY(change_set_id, path)
			)
		`);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS review_entries (
				id TEXT PRIMARY KEY NOT NULL,
				path TEXT NOT NULL,
				action TEXT NOT NULL,
				before_content TEXT,
				after_content TEXT,
				snapshot_id TEXT,
				status TEXT DEFAULT 'pending' NOT NULL,
				hunk_statuses TEXT DEFAULT '[]' NOT NULL,
				latest_session_id TEXT NOT NULL,
				session_ids TEXT DEFAULT '[]' NOT NULL,
				diff_signature TEXT DEFAULT '' NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
		this.ctx.storage.sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS review_entries_path_idx ON review_entries (path)');
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS review_entry_sources (
				review_entry_id TEXT NOT NULL,
				change_set_id TEXT NOT NULL,
				order_index INTEGER NOT NULL,
				PRIMARY KEY(review_entry_id, change_set_id)
			)
		`);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS review_resolutions (
				id TEXT PRIMARY KEY NOT NULL,
				review_entry_id TEXT NOT NULL,
				decision TEXT NOT NULL,
				hunk_statuses TEXT DEFAULT '[]' NOT NULL,
				resolved_at INTEGER NOT NULL
			)
		`);
	}

	private async withProjectMount<T>(callback: () => Promise<T>, projectId = this.getProjectId()): Promise<T> {
		const filesystemId = toDurableObjectId(filesystemNamespace, projectId);
		const filesystemStub = filesystemNamespace.get(filesystemId);
		return runWithProjectStub(filesystemStub, callback);
	}

	// =========================================================================
	// Database Helpers
	// =========================================================================
	private buildUserMessage(
		parts: UserMessagePart[],
		mode: AgentMode,
		model: AIModelId,
		state: 'queued' | 'committed',
		authorUserId?: string,
		messageId = crypto.randomUUID(),
		createdAt = Date.now(),
	): ChatMessage {
		return {
			id: messageId,
			role: 'user',
			parts,
			authorUserId,
			createdAt,
			metadata: {
				request: {
					mode,
					model,
					state,
				},
			},
		};
	}

	private lookupSessionIdForMessage(messageId: string): string | undefined {
		const row = this.sql<{ sessionId: string }>`
			SELECT session_id as sessionId
			FROM assistant_messages
			WHERE id = ${messageId}
			LIMIT 1
		`[0];
		return row?.sessionId;
	}

	private async lookupProjectOrganizationId(projectId: string): Promise<string | undefined> {
		const database = drizzle(env.DB, { schema: authSchema });
		const projectRow = await database
			.select({ organizationId: authSchema.project.organizationId })
			.from(authSchema.project)
			.where(and(eq(authSchema.project.id, projectId), isNull(authSchema.project.deletedAt), isNull(authSchema.project.bannedAt)))
			.limit(1);

		return projectRow[0]?.organizationId;
	}

	private loadPendingChangesFromDatabase(): Record<string, PendingFileChange> {
		const data = readPendingChangesData(this.db);
		try {
			return JSON.parse(data);
		} catch {
			return {};
		}
	}
	private savePendingChangesToDatabase(changes: Record<string, PendingFileChange>): void {
		writePendingChangesData(this.db, JSON.stringify(changes));
	}
	private getSurvivingSnapshotIds(): Set<string> {
		const surviving = new Set<string>();
		const changes = this.loadPendingChangesFromDatabase();
		for (const change of Object.values(changes)) {
			if (change.snapshotId) {
				surviving.add(change.snapshotId);
			}
		}
		return surviving;
	}

	/**
	 * Send a push notification to the session initiator.
	 * Uses the explicitly provided userId (persisted in StartAgentParameters)
	 * rather than scanning live WebSocket connections, so notifications
	 * work correctly after DO eviction and in multi-user projects.
	 */
	private sendPushNotification(userId: string, notification: PushNotification): void {
		const projectId = this.getProjectId();
		if (!projectId) return;

		try {
			const deepLinkTarget = { kind: 'agent-session' as const, sessionId: notification.tag };
			const enrichedNotification: PushNotification = {
				...notification,
				path: notification.path ?? buildProjectDeepLinkPath(projectId, deepLinkTarget),
				deepLink: notification.deepLink ?? {
					projectId,
					target: deepLinkTarget,
				},
			};
			env.PUSH.notifyUser(userId, enrichedNotification).catch((error: unknown) => {
				console.error('[AgentRunner] Failed to send push notification:', error);
			});
		} catch {
			// Push service binding may not be available in dev
		}
	}

	private ensureSessionRecord(sessionId: string, title: string, model?: AIModelId, source?: AgentMode): void {
		/* eslint-disable unicorn/no-null -- SQL NULL values are required for optional session fields */
		this.sql`
			INSERT OR IGNORE INTO assistant_sessions (id, name, parent_session_id, model, source)
			VALUES (${sessionId}, ${title}, NULL, ${model ?? null}, ${source ?? null})
		`;
		/* eslint-enable unicorn/no-null */
	}

	private getContextBlocksSummary(sessionId: string): Record<string, { description?: string; available?: boolean }> {
		return Object.fromEntries(
			this.sessionManager
				.getSession(sessionId)
				.getContextBlocks()
				.map((block) => [block.label, { description: block.description, available: true }]),
		);
	}

	private getLoadedExtensionsSummary(): Array<{ name: string; description?: string; toolCount: number }> {
		return buildLoadedExtensionsSummary(this.extensionManager);
	}

	private async getSessionTurnAgent(sessionId: string, model: AIModelId) {
		const modelConfig = getModelConfig(model);
		if (modelConfig?.provider === 'workers-ai' && !env.AI) {
			throw new Error('Workers AI binding (AI) is not configured.');
		}
		const sessionAgent = await this.subAgent(SessionTurnAgent, sessionId);
		await sessionAgent.configureSessionTurn({
			projectId: this.getProjectId(),
			organizationId: this.projectOrganizationId,
			sessionId,
			requestOriginContext: this.requestOriginContext,
		});
		return sessionAgent;
	}

	private getProjectId(): string {
		return this.name.startsWith('agent:') ? this.name.slice(6) : this.name;
	}
}
