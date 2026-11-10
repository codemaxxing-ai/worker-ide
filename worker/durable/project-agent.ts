import { Agent } from 'agents';
import { AgentContextProvider, AgentSearchProvider } from 'agents/context';

import { defaultAgentSettings } from '@shared/agent-chat';
import { MAX_AI_SESSIONS_PER_PROJECT, MCP_SERVERS } from '@shared/constants';
import { buildProjectDeepLinkPath } from '@shared/project-deep-link';
import { sessionTitleSchema } from '@shared/validation';

import { getDatabase } from './db';
import { initializeReviewStorage } from './db/initialize';
import { SessionTurnAgent } from './session-turn-agent';
import { filesystemNamespace } from '../lib/durable-object-namespaces';
import { runWithProjectStub } from '../lib/project-fs';
import { toDurableObjectId } from '../lib/project-id';
import { accumulatePendingChange } from '../services/agent/pending-changes';
import { ReviewQueueStore } from '../services/agent/review-queue';
import { cleanupSessionArtifacts } from '../services/agent/session-cleanup';
import { deriveFallbackTitle, generateSessionTitle } from '../services/agent/title-generator';

import type { AgentDatabase } from './db';
import type { RequestOriginContext } from '../services/agent/request-origin-context';
import type { ChatConfiguration, AgentMessage } from '@shared/agent-chat';
import type { AgentState, SessionSummary } from '@shared/agent-state';
import type { PendingFileChange } from '@shared/types';
import type { Connection } from 'agents';

export interface CreateAgentSession {
	id: string;
	projectId: string;
	organizationId?: string;
	title?: string;
	model?: ChatConfiguration['model'];
	mode?: ChatConfiguration['mode'];
	requestOriginContext: RequestOriginContext;
}

/** Project directory and review state. Conversations live only in their Think facets. */
export class ProjectAgent extends Agent<Env, AgentState> {
	static options = { sendIdentityOnConnect: true };
	initialState: AgentState = {
		ready: false,
		sessions: [],
		reviewEntries: {},
		reviewSummary: { unresolvedCount: 0, reviewVersion: 0, sessionCounts: {} },
	};
	private database!: AgentDatabase;
	private reviews!: ReviewQueueStore;
	private readonly memory = new AgentContextProvider(this, 'memory');
	private readonly artifacts = new AgentSearchProvider(this);
	private preparation?: Promise<void>;
	private readonly deletions = new Map<string, Promise<void>>();

	override validateStateChange(_state: AgentState, source: Connection | 'server'): void {
		if (source !== 'server') throw new Error('Project agent state is server-owned');
	}

	override async onStart(): Promise<void> {
		initializeReviewStorage(this.ctx.storage);
		this.database = getDatabase(this.ctx.storage);
		this.reviews = new ReviewQueueStore(this.database);
		this.artifacts.init('artifacts');
		this.refreshReviews();
		if (!this.state.ready) await this.queue('prepareProject', {});
	}

	async prepareProject(): Promise<void> {
		if (this.state.ready) return;
		this.preparation ??= this.prepareWorkspace().finally(() => {
			this.preparation = undefined;
		});
		return this.preparation;
	}
	private async prepareWorkspace(): Promise<void> {
		try {
			const filesystem = filesystemNamespace.get(toDurableObjectId(filesystemNamespace, this.projectId));
			await filesystem.resetAgentArtifacts();
			for (const server of MCP_SERVERS)
				await this.addMcpServer(server.name, server.endpoint, { id: server.id }).catch((error: unknown) =>
					console.error('Project MCP connection failed', { server: server.id, error }),
				);
			this.setState({ ...this.state, ready: true, setupError: undefined });
		} catch (error) {
			this.setState({ ...this.state, setupError: error instanceof Error ? error.message : 'Agent setup failed' });
			throw error;
		}
	}

	override async onBeforeSubAgent(_request: Request, target: { className: string; name: string }): Promise<Response | void> {
		if (
			target.className !== SessionTurnAgent.name ||
			this.ctx.storage.kv.get(`deleting:${target.name}`) ||
			!this.state.sessions.some((session) => session.id === target.name)
		)
			return new Response('Session not found', { status: 404 });
	}

	async createSession(input: CreateAgentSession): Promise<SessionSummary> {
		if (!this.state.ready) throw new Error('Agent setup is still running');
		if (this.ctx.storage.kv.get(`deleting:${input.id}`)) throw new Error('Session is being deleted');
		const existing = this.state.sessions.find((session) => session.id === input.id);
		if (existing) return existing;
		if (this.state.sessions.length >= MAX_AI_SESSIONS_PER_PROJECT) throw new Error('Delete a session before creating another.');
		const child = await this.dynamicAgents.get(SessionTurnAgent, input.id);
		const configuration: ChatConfiguration = {
			projectId: input.projectId,
			organizationId: input.organizationId,
			sessionId: input.id,
			model: input.model ?? defaultAgentSettings.model,
			mode: input.mode ?? defaultAgentSettings.mode,
			requestOriginContext: input.requestOriginContext,
		};
		await child.configureSessionTurn(configuration);
		const committed = this.state.sessions.find((session) => session.id === input.id);
		if (committed) return committed;
		const now = Date.now();
		const summary: SessionSummary = {
			id: input.id,
			title: input.title ? sessionTitleSchema.parse(input.title) : 'New session',
			createdAt: now,
			updatedAt: now,
			model: configuration.model,
			mode: configuration.mode,
			status: 'idle',
			isRunning: false,
			revision: 0,
			titleGenerated: Boolean(input.title),
		};
		this.setState({ ...this.state, sessions: [summary, ...this.state.sessions] });
		return summary;
	}

	private async getChat(id: string) {
		if (this.ctx.storage.kv.get(`deleting:${id}`)) throw new Error('Session is being deleted');
		if (!this.state.sessions.some((session) => session.id === id)) throw new Error('Session not found');
		return this.dynamicAgents.get(SessionTurnAgent, id);
	}
	async readSessionHistory(id: string, before?: string, leafId?: string) {
		const chat = await this.getChat(id);
		return chat.readHistory(before, leafId);
	}
	async sessionBranches(id: string, messageId: string) {
		const chat = await this.getChat(id);
		return chat.branches(messageId);
	}
	async cancelSession(id: string): Promise<void> {
		const chat = await this.getChat(id);
		await chat.cancelActiveSubmissions();
	}
	async cancelQueuedMessage(id: string, submissionId: string, userId: string) {
		const chat = await this.getChat(id);
		return chat.cancelSubmissionById(submissionId, userId);
	}
	listSessions(): SessionSummary[] {
		return this.state.sessions;
	}

	async submitMessage(sessionId: string, message: AgentMessage) {
		const child = await this.getChat(sessionId);
		const receipt = await child.submitTurn(message);
		const summary = this.state.sessions.find((session) => session.id === sessionId);
		if (summary && !summary.titleGenerated) {
			const text = message.parts
				.filter((part) => part.type === 'text')
				.map((part) => part.text)
				.join('\n');
			this.updateSession(sessionId, { title: deriveFallbackTitle(text), titleGenerated: true });
			await this.queue('generateTitle', { sessionId, text, fallback: deriveFallbackTitle(text) });
		}
		return receipt;
	}

	async generateTitle(input: { sessionId: string; text: string; fallback: string }): Promise<void> {
		const result = await generateSessionTitle(input.text, { projectId: this.projectId });
		if (this.state.sessions.find((session) => session.id === input.sessionId)?.title === input.fallback)
			this.updateSession(input.sessionId, { title: result.title });
	}

	async configureSession(id: string, settings: Pick<ChatConfiguration, 'mode' | 'model'>): Promise<void> {
		const child = await this.getChat(id);
		await child.updateSettings(settings);
		this.updateSession(id, settings);
	}

	renameSession(id: string, title: string): void {
		if (!this.state.sessions.some((session) => session.id === id)) throw new Error('Session not found');
		this.updateSession(id, { title: sessionTitleSchema.parse(title), titleGenerated: true });
	}

	async deleteSession(id: string): Promise<void> {
		const pending = this.deletions.get(id);
		if (pending) return pending;
		const deleting = this.deleteSessionData(id).finally(() => this.deletions.delete(id));
		this.deletions.set(id, deleting);
		return deleting;
	}
	private async deleteSessionData(id: string): Promise<void> {
		const session = this.state.sessions.find((candidate) => candidate.id === id);
		if (!session) return;
		// Keep this tombstone after deletion so a delayed create request cannot recreate the same identity.
		this.ctx.storage.kv.put(`deleting:${id}`, true);
		const child = await this.dynamicAgents.get(SessionTurnAgent, id);
		await child.closeAdmissions();
		await child.cancelActiveSubmissions();
		await child.waitForCompletion();
		await child.flushFinalizations();
		await this.withWorkspace(() => cleanupSessionArtifacts('/project', new Set([id]), new Set()));
		await this.dynamicAgents.delete(SessionTurnAgent, id);
		this.reviews.removeSession(id);
		this.setState({ ...this.state, sessions: this.state.sessions.filter((candidate) => candidate.id !== id) });
		this.refreshReviews();
	}

	async searchSessions(query: string) {
		const matches: Array<{ sessionId: string; messageId: string; content: string }> = [];
		for (const session of this.state.sessions) {
			if (this.ctx.storage.kv.get(`deleting:${session.id}`)) continue;
			const child = await this.getChat(session.id);
			for (const result of await child.searchHistory(query)) matches.push({ ...result, sessionId: session.id });
		}
		return matches.slice(0, 50);
	}

	updateSessionSummary(id: string, patch: Pick<SessionSummary, 'status' | 'revision' | 'finalizing'>): void {
		const current = this.state.sessions.find((session) => session.id === id);
		if (!current || patch.revision <= current.revision) return;
		this.updateSession(id, { ...patch, isRunning: patch.status === 'running' || patch.finalizing === true, updatedAt: Date.now() });
	}

	async completeSessionOperation(input: {
		summary: Pick<SessionSummary, 'status' | 'revision' | 'finalizing'>;
		sessionId: string;
		submissionId: string;
		changes: Record<string, PendingFileChange>;
		status: 'completed' | 'error' | 'aborted';
		initiatorUserId?: string;
	}): Promise<void> {
		if (!this.state.sessions.some((session) => session.id === input.sessionId)) return;
		const key = `completed:${input.sessionId}:${input.submissionId}`;
		if (!this.ctx.storage.kv.get(key))
			this.ctx.storage.transactionSync(() => {
				const changes = new Map(Object.entries(this.reviews.readSessionPendingChanges(input.sessionId)));
				for (const change of Object.values(input.changes)) accumulatePendingChange(changes, change);
				this.reviews.syncSessionPendingChanges(input.sessionId, Object.fromEntries(changes));
				this.ctx.storage.kv.put(key, true);
			});
		this.refreshReviews();
		const notificationKey = `${key}:notification`;
		if (input.initiatorUserId && !this.ctx.storage.kv.get(notificationKey)) {
			const title =
				input.status === 'completed' ? 'Agent completed' : input.status === 'aborted' ? 'Agent stopped' : 'Agent needs attention';
			await this.env.PUSH.notifyUser(input.initiatorUserId, {
				title,
				body: this.state.sessions.find((session) => session.id === input.sessionId)?.title ?? 'Agent session',
				tag: `${input.sessionId}:${input.submissionId}`,
				path: buildProjectDeepLinkPath(this.projectId, { kind: 'agent-session', sessionId: input.sessionId }),
			});
			this.ctx.storage.kv.put(notificationKey, true);
		}
		this.updateSessionSummary(input.sessionId, input.summary);
	}

	readSharedMemory() {
		return this.memory.get();
	}
	writeSharedMemory(content: string) {
		return this.memory.set(content);
	}
	indexArtifact(entry: { key: string; content: string }) {
		return this.artifacts.set(entry.key, entry.content);
	}
	searchArtifacts(query: string) {
		return this.artifacts.search(query);
	}
	async listMcpTools(): Promise<Array<{ serverId: string; name: string; description?: string; inputSchema: Record<string, unknown> }>> {
		await this.mcp.waitForConnections();
		return this.mcp.listTools().map(({ serverId, name, description, inputSchema }) => ({ serverId, name, description, inputSchema }));
	}
	async callMcpTool(serverId: string, name: string, arguments_: Record<string, unknown>): Promise<{ isError: boolean; content: string }> {
		const result = await this.mcp.callTool({ serverId, name, arguments: arguments_ });
		return { isError: result.isError === true, content: JSON.stringify(result.content) };
	}

	listReviewEntries() {
		return this.reviews.listReviewEntries();
	}
	async updateReviewHunks(id: string, hunks: PendingFileChange['hunkStatuses'], liveContent?: string): Promise<void> {
		await this.withWorkspace(() => this.reviews.updateHunkStatuses('/project', this.projectId, id, hunks, liveContent));
		this.refreshReviews();
	}
	async resolveReviewEntry(id: string, decision: 'accept' | 'reject', liveContent?: string): Promise<void> {
		await this.withWorkspace(() => this.reviews.resolveEntry('/project', this.projectId, id, decision, liveContent));
		this.refreshReviews();
	}
	async resolveReviewEntries(
		decision: 'accept' | 'reject',
		sessionId?: string,
		reviewIds?: string[],
		liveContents?: Record<string, string>,
	): Promise<void> {
		await this.withWorkspace(() => this.reviews.resolveEntries('/project', this.projectId, decision, sessionId, reviewIds, liveContents));
		this.refreshReviews();
	}
	async syncReviewPathFromWorkspace(path: string): Promise<void> {
		await this.withWorkspace(() => this.reviews.syncTrackedPathFromWorkspace('/project', path));
		this.refreshReviews();
	}
	moveTrackedReviewPath(from: string, to: string): void {
		this.reviews.moveTrackedPath(from, to);
		this.refreshReviews();
	}
	getRunningSessionIds(): string[] {
		return this.state.sessions.filter((session) => session.isRunning).map((session) => session.id);
	}

	private updateSession(id: string, patch: Partial<SessionSummary>): void {
		this.setState({
			...this.state,
			sessions: this.state.sessions.map((session) => (session.id === id ? { ...session, ...patch } : session)),
		});
	}
	private refreshReviews(): void {
		this.setState({
			...this.state,
			reviewEntries: this.reviews.listReviewEntriesRecord(),
			reviewSummary: this.reviews.getReviewSummary(Date.now()),
		});
	}
	private get projectId(): string {
		return this.name.replace(/^agent:/, '');
	}
	private withWorkspace<T>(callback: () => Promise<T>): Promise<T> {
		return runWithProjectStub(filesystemNamespace.get(toDurableObjectId(filesystemNamespace, this.projectId)), callback);
	}
}
