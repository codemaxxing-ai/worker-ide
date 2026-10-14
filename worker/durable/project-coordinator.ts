import { DurableObject } from 'cloudflare:workers';

import { COLLAB_COLORS, MAX_CONCURRENT_COLLABORATORS } from '@shared/constants';
import { serializeMessage, parseClientMessage } from '@shared/ws-messages';

import { trackWebSocketEvent } from '../lib/analytics';

import type { RuntimeStatus } from '@shared/runtime-status';
import type { AssetSettings, BindingsConfig, HmrUpdate, Participant } from '@shared/types';
import type { ServerMessage } from '@shared/ws-messages';
type ProjectSocketClientKind = 'ide' | 'preview';

interface ParticipantAttachment {
	id: string;
	color: string;
	kind: ProjectSocketClientKind;
	collaborationVisible: boolean;
	file?: string;
	cursor?: { line: number; ch: number };
	selection?: { anchor: { line: number; ch: number }; head: { line: number; ch: number } };
	joined: boolean;
}

type WranglerSettingsDomain = 'asset-settings' | 'bindings-config';

type RecentExternalChange =
	| {
			kind: 'file-edit';
			path: string;
			timestamp: number;
	  }
	| {
			kind: 'wrangler-settings';
			path: '/wrangler.jsonc';
			timestamp: number;
			domains: WranglerSettingsDomain[];
			assetSettings?: AssetSettings;
			bindingsConfig?: BindingsConfig;
	  };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeAssetSettings(value: unknown): AssetSettings | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	const normalizedSettings: AssetSettings = {};
	if (
		value.not_found_handling === 'none' ||
		value.not_found_handling === 'single-page-application' ||
		value.not_found_handling === '404-page'
	) {
		normalizedSettings.not_found_handling = value.not_found_handling;
	}
	if (
		value.html_handling === 'auto-trailing-slash' ||
		value.html_handling === 'force-trailing-slash' ||
		value.html_handling === 'drop-trailing-slash' ||
		value.html_handling === 'none'
	) {
		normalizedSettings.html_handling = value.html_handling;
	}
	if (typeof value.run_worker_first === 'boolean') {
		normalizedSettings.run_worker_first = value.run_worker_first;
	}
	if (Array.isArray(value.run_worker_first) && value.run_worker_first.every((entry) => typeof entry === 'string')) {
		normalizedSettings.run_worker_first = value.run_worker_first;
	}

	return Object.keys(normalizedSettings).length > 0 ? normalizedSettings : {};
}

function normalizeBindingsConfig(value: unknown): BindingsConfig | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	const normalizedBindings: BindingsConfig = {};
	if (typeof value.storage === 'boolean') {
		normalizedBindings.storage = value.storage;
	}

	return Object.keys(normalizedBindings).length > 0 ? normalizedBindings : {};
}

function normalizeRecentExternalChange(value: unknown): RecentExternalChange | undefined {
	if (!isRecord(value) || typeof value.path !== 'string' || typeof value.timestamp !== 'number') {
		return undefined;
	}

	if (value.kind === 'wrangler-settings') {
		const domains = Array.isArray(value.domains)
			? value.domains.filter((domain): domain is WranglerSettingsDomain => domain === 'asset-settings' || domain === 'bindings-config')
			: [];
		if (domains.length === 0) {
			return undefined;
		}

		return {
			kind: 'wrangler-settings',
			path: '/wrangler.jsonc',
			timestamp: value.timestamp,
			domains,
			assetSettings: normalizeAssetSettings(value.assetSettings),
			bindingsConfig: normalizeBindingsConfig(value.bindingsConfig),
		};
	}

	return {
		kind: 'file-edit',
		path: value.path,
		timestamp: value.timestamp,
	};
}

/**
 * Storage keys used by the synchronous KV API (`ctx.storage.kv`).
 * All persisted values must be serializable via the structured clone algorithm.
 */
const STORAGE_KEY = {
	LAST_SERVER_ERROR: 'lastServerError',
	UPDATE_VERSION: 'updateVersion',
	OUTPUT_LOGS: 'outputLogs',
	RECENT_FILE_EDITS: 'recentFileEdits',
	IS_VINEXT_PREVIEW: 'isVinextPreview',
};

/**
 * Project Coordinator Durable Object
 *
 * Manages WebSocket connections for:
 * - Hot Module Replacement (HMR) update broadcasts to preview and editor clients
 * - Real-time collaboration (cursor positions, file edits)
 * - Server error and log forwarding
 *
 * Each project has its own ProjectCoordinator instance (keyed by `project:${projectId}`).
 *
 * All durable state is persisted to the DO's SQLite-backed storage via
 * `ctx.storage.kv` so it survives hibernation and eviction.
 */
export class ProjectCoordinatorV2 extends DurableObject {
	constructor(state: DurableObjectState, environment: Env) {
		super(state, environment);
		this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
	}
	private projectId: string | undefined;
	private static readonly MAX_RECENT_EXTERNAL_CHANGES = 100;

	// =========================================================================
	// Persisted state — native get/set backed by ctx.storage.kv
	// =========================================================================
	private get lastServerError(): string | undefined {
		return this.ctx.storage.kv.get<string>(STORAGE_KEY.LAST_SERVER_ERROR);
	}

	private set lastServerError(value: string | undefined) {
		if (value === undefined) {
			this.ctx.storage.kv.delete(STORAGE_KEY.LAST_SERVER_ERROR);
		} else {
			this.ctx.storage.kv.put(STORAGE_KEY.LAST_SERVER_ERROR, value);
		}
	}
	private get updateVersion(): number {
		return this.ctx.storage.kv.get<number>(STORAGE_KEY.UPDATE_VERSION) ?? 0;
	}

	private set updateVersion(value: number) {
		this.ctx.storage.kv.put(STORAGE_KEY.UPDATE_VERSION, value);
	}

	getUpdateVersion(): number {
		return this.updateVersion;
	}

	private get isVinextPreview(): boolean {
		return this.ctx.storage.kv.get<boolean>(STORAGE_KEY.IS_VINEXT_PREVIEW) ?? false;
	}

	/**
	 * Mark this project as using the vinext preview. Preview sockets receive HMR
	 * exclusively through `vinext:hmr` custom events, which carry React Fast
	 * Refresh and the state-preserving server refresh; the generic
	 * `update`/`full-reload` broadcast is reserved for non-preview clients.
	 */
	markVinextPreview(): void {
		this.ctx.storage.kv.put(STORAGE_KEY.IS_VINEXT_PREVIEW, true);
	}

	private get outputLogs(): string {
		return this.ctx.storage.kv.get<string>(STORAGE_KEY.OUTPUT_LOGS) ?? '';
	}

	private set outputLogs(value: string) {
		this.ctx.storage.kv.put(STORAGE_KEY.OUTPUT_LOGS, value);
	}
	private get recentExternalChanges(): RecentExternalChange[] {
		const storedValue = this.ctx.storage.kv.get<unknown>(STORAGE_KEY.RECENT_FILE_EDITS);
		if (!Array.isArray(storedValue)) {
			return [];
		}

		return storedValue
			.map((value) => normalizeRecentExternalChange(value))
			.filter((value): value is RecentExternalChange => value !== undefined);
	}

	private set recentExternalChanges(value: RecentExternalChange[]) {
		if (value.length === 0) {
			this.ctx.storage.kv.delete(STORAGE_KEY.RECENT_FILE_EDITS);
		} else {
			this.ctx.storage.kv.put(STORAGE_KEY.RECENT_FILE_EDITS, value);
		}
	}

	private appendRecentExternalChange(change: RecentExternalChange): void {
		const recentExternalChanges = this.recentExternalChanges;
		recentExternalChanges.push(change);
		if (recentExternalChanges.length > ProjectCoordinatorV2.MAX_RECENT_EXTERNAL_CHANGES) {
			recentExternalChanges.splice(0, recentExternalChanges.length - ProjectCoordinatorV2.MAX_RECENT_EXTERNAL_CHANGES);
		}
		this.recentExternalChanges = recentExternalChanges;
	}

	private getAttachment(ws: WebSocket): ParticipantAttachment | undefined {
		try {
			const attachment: ParticipantAttachment = ws.deserializeAttachment();
			return attachment;
		} catch {
			return undefined;
		}
	}

	private setAttachment(ws: WebSocket, data: ParticipantAttachment): void {
		ws.serializeAttachment(data);
	}

	private nextColor(): string {
		// Derive color index from current WebSocket count so it survives DO hibernation
		const currentCount = this.ctx.getWebSockets().length;
		return COLLAB_COLORS[currentCount % COLLAB_COLORS.length];
	}

	private isJoinedIdeAttachment(attachment: ParticipantAttachment | undefined): attachment is ParticipantAttachment {
		return attachment?.kind === 'ide' && attachment.joined;
	}

	private isVisibleJoinedIdeAttachment(attachment: ParticipantAttachment | undefined): attachment is ParticipantAttachment {
		return this.isJoinedIdeAttachment(attachment) && attachment.collaborationVisible;
	}

	private getAllParticipants(excludeId?: string): Participant[] {
		const participants: Participant[] = [];
		for (const ws of this.ctx.getWebSockets()) {
			if (ws.readyState !== WebSocket.OPEN) continue;
			const att = this.getAttachment(ws);
			if (this.isVisibleJoinedIdeAttachment(att) && att.id !== excludeId) {
				participants.push({
					id: att.id,
					color: att.color,
					file: att.file,
					cursor: att.cursor,
					selection: att.selection,
				});
			}
		}
		return participants;
	}

	private sendToOtherJoinedIdeSockets(sender: WebSocket, message: string): void {
		for (const ws of this.ctx.getWebSockets()) {
			if (ws === sender || ws.readyState !== WebSocket.OPEN) continue;
			const att = this.getAttachment(ws);
			if (!this.isJoinedIdeAttachment(att)) continue;
			try {
				ws.send(message);
			} catch {
				try {
					ws.close(1011, 'send failed');
				} catch {
					// Ignore close errors
				}
			}
		}
	}

	private sendToOtherVisibleParticipants(sender: WebSocket, message: string): void {
		for (const ws of this.ctx.getWebSockets()) {
			if (ws === sender || ws.readyState !== WebSocket.OPEN) continue;
			const att = this.getAttachment(ws);
			if (!this.isVisibleJoinedIdeAttachment(att)) continue;
			try {
				ws.send(message);
			} catch {
				try {
					ws.close(1011, 'send failed');
				} catch {
					// Ignore close errors
				}
			}
		}
	}

	private sendToAll(message: string): void {
		for (const ws of this.ctx.getWebSockets()) {
			if (ws.readyState !== WebSocket.OPEN) continue;
			try {
				ws.send(message);
			} catch {
				try {
					ws.close(1011, 'send failed');
				} catch {
					// Ignore close errors
				}
			}
		}
	}

	private sendToKind(kind: ProjectSocketClientKind, message: string): void {
		for (const ws of this.ctx.getWebSockets()) {
			if (ws.readyState !== WebSocket.OPEN) continue;
			const att = this.getAttachment(ws);
			if (!att || att.kind !== kind) continue;
			try {
				ws.send(message);
			} catch {
				try {
					ws.close(1011, 'send failed');
				} catch {
					// Ignore close errors
				}
			}
		}
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// Capture the project ID forwarded by the main Worker for analytics
		const headerProjectId = request.headers.get('x-project-id');
		if (headerProjectId) {
			this.projectId = headerProjectId;
		}

		// WebSocket upgrade
		if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
			const clientKind = request.headers.get('x-worker-ide-client-kind') === 'preview' ? 'preview' : 'ide';
			// Enforce concurrent collaborator limit
			const openSockets = this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN);
			const openIdeSockets = openSockets.filter((ws) => this.getAttachment(ws)?.kind === 'ide');
			if (clientKind === 'ide' && openIdeSockets.length >= MAX_CONCURRENT_COLLABORATORS) {
				return new Response('Too many collaborators', { status: 429 });
			}

			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair);

			const participantId = crypto.randomUUID();
			const color = this.nextColor();
			const collaborationVisible = clientKind === 'ide' ? request.headers.get('x-worker-ide-collaboration-visible') !== 'false' : true;
			const attachment: ParticipantAttachment = {
				id: participantId,
				color,
				kind: clientKind,
				collaborationVisible,
				joined: false,
			};

			this.ctx.acceptWebSocket(server);
			this.setAttachment(server, attachment);

			trackWebSocketEvent({
				projectId: this.projectId ?? this.ctx.id.toString(),
				eventType: 'connect',
				connectionType: 'coordinator',
				concurrentConnections: openSockets.length + 1,
			});

			return new Response(undefined, { status: 101, webSocket: client });
		}

		return new Response('Not found', { status: 404 });
	}

	// =========================================================================
	// RPC methods (called directly from other workers via stub)
	// =========================================================================

	async triggerUpdate(update: HmrUpdate): Promise<void> {
		await this.broadcastHmrUpdate(update);
	}

	/**
	 * Broadcast a server-side rebuild lifecycle signal to preview sockets so the
	 * IDE can surface a rebuilding indicator during a (potentially slow) warm-build
	 * adapter build. Cosmetic only: unlike `vinext:hmr` it carries no version and
	 * never drives module application, so it is safe to drop.
	 */
	broadcastPreviewRebuildStatus(status: 'start' | 'end'): void {
		this.sendToKind('preview', JSON.stringify({ type: 'custom', event: 'preview:rebuild', data: { status } }));
	}

	async sendMessage(message: ServerMessage): Promise<void> {
		const serialized = serializeMessage(message);
		// Track last server-error so it can be replayed to late-joining clients
		if (message.type === 'server-error') {
			this.lastServerError = serialized;
			this.sendToAll(serialized);
			return;
		}
		this.sendToKind('ide', serialized);
	}

	updateRuntimeStatus(status: RuntimeStatus): void {
		const previous = this.ctx.storage.kv.get<RuntimeStatus>('project-runtime-status');
		if (previous && previous.revision >= status.revision) return;
		this.ctx.storage.kv.put('project-runtime-status', status);
		this.sendToKind('ide', serializeMessage({ type: 'runtime-status', status }));
		this.sendToKind('preview', serializeMessage({ type: 'runtime-status', status }));
	}

	async closeProjectConnections(code: number, reason: string): Promise<void> {
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.close(code, reason);
			} catch {
				// Ignore close errors
			}
		}
	}

	/**
	 * Get the latest IDE output logs snapshot.
	 * Called by the AI agent service between iterations to check for new errors/warnings.
	 */
	async getOutputLogs(): Promise<string> {
		return this.outputLogs;
	}

	/**
	 * Drain recent external changes made while the agent was running.
	 * Called by the AI agent service between iterations to detect concurrent
	 * user changes. Returns deduplicated file edits plus merged Wrangler settings updates.
	 */
	async getRecentExternalChanges(): Promise<RecentExternalChange[]> {
		const recentExternalChanges = this.recentExternalChanges;
		if (recentExternalChanges.length === 0) return [];
		this.recentExternalChanges = [];

		const latestFileEditsByPath = new Map<string, Extract<RecentExternalChange, { kind: 'file-edit' }>>();
		const wranglerDomains = new Set<WranglerSettingsDomain>();
		let latestWranglerTimestamp = 0;
		let latestAssetSettings: AssetSettings | undefined;
		let latestBindingsConfig: BindingsConfig | undefined;

		for (const change of recentExternalChanges) {
			if (change.kind === 'file-edit') {
				const existing = latestFileEditsByPath.get(change.path);
				if (!existing || change.timestamp > existing.timestamp) {
					latestFileEditsByPath.set(change.path, change);
				}
				continue;
			}

			latestWranglerTimestamp = Math.max(latestWranglerTimestamp, change.timestamp);
			for (const domain of change.domains) {
				wranglerDomains.add(domain);
			}
			if (change.assetSettings !== undefined) {
				latestAssetSettings = change.assetSettings;
			}
			if (change.bindingsConfig !== undefined) {
				latestBindingsConfig = change.bindingsConfig;
			}
		}

		const deduplicatedChanges: RecentExternalChange[] = [...latestFileEditsByPath.values()];
		if (wranglerDomains.size > 0) {
			deduplicatedChanges.push({
				kind: 'wrangler-settings',
				path: '/wrangler.jsonc',
				timestamp: latestWranglerTimestamp,
				domains: [...wranglerDomains],
				assetSettings: latestAssetSettings,
				bindingsConfig: latestBindingsConfig,
			});
		}

		return deduplicatedChanges.toSorted((left, right) => left.timestamp - right.timestamp);
	}

	async recordExternalChange(change: RecentExternalChange): Promise<void> {
		this.appendRecentExternalChange(change);
	}
	private sendCollabState(ws: WebSocket, attachment: ParticipantAttachment): void {
		try {
			ws.send(
				serializeMessage({
					type: 'collab-state',
					selfId: attachment.id,
					selfColor: attachment.color,
					participants: attachment.collaborationVisible ? this.getAllParticipants(attachment.id) : [],
				}),
			);
		} catch {
			// Ignore send errors — client may have disconnected
		}
	}

	private async broadcastHmrUpdate(update: HmrUpdate): Promise<void> {
		// Clear stale error on any successful preview update or full reload.
		// A successful file write means the previous error may no longer apply.
		if (this.lastServerError !== undefined) {
			this.lastServerError = undefined;
		}

		// Increment the monotonic version counter. Clients track the latest
		// version they have seen and send it on reconnect so we can detect
		// whether they missed any updates during a reload window.
		const nextVersion = this.updateVersion + 1;
		this.updateVersion = nextVersion;

		const message = serializeMessage({
			type: update.type,
			version: nextVersion,
			updates: [
				{
					type: update.type,
					path: update.path,
					timestamp: update.timestamp,
					targets: update.targets,
				},
			],
		});

		if (this.isVinextPreview) {
			// vinext drives module-level HMR: the preview glue re-imports the changed
			// client component (React Fast Refresh, state preserved) or runs the
			// router's server refresh for server-component edits. Preview sockets
			// receive a single `vinext:hmr` event carrying that change.
			this.sendToKind('preview', JSON.stringify({ type: 'custom', event: 'vinext:hmr', data: { path: update.path } }));
			return;
		}

		this.sendToAll(message);
	}

	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
		try {
			const messageString = typeof message === 'string' ? message : new TextDecoder().decode(message);
			const parsed = parseClientMessage(messageString);
			if (!parsed.success) return;
			const data = parsed.data;
			const att = this.getAttachment(ws);
			if (!att) return;

			if (data.type === 'hmr-connect') {
				// The HMR client sends its last-seen version after connecting
				// (or reconnecting post-reload). If the coordinator's version
				// is higher, the client missed one or more updates and needs
				// to reload to pick up the latest content.
				const currentVersion = this.updateVersion;
				if (data.version < currentVersion) {
					try {
						ws.send(
							serializeMessage({
								type: 'full-reload',
								version: currentVersion,
								updates: [
									{
										type: 'full-reload',
										path: '*',
										timestamp: Date.now(),
										targets: [],
									},
								],
							}),
						);
					} catch {
						// Ignore send errors
					}
				}

				// Reconnecting standalone previews may have missed a runtime transition.
				const runtimeStatus = this.ctx.storage.kv.get<RuntimeStatus>('project-runtime-status');
				if (runtimeStatus) ws.send(serializeMessage({ type: 'runtime-status', status: runtimeStatus }));

				// Replay the last bundle error to a freshly-connected (or reloaded)
				// preview so its in-iframe overlay reflects the current state without
				// the editor having to forward it. The preview client renders the
				// overlay for bundle errors; runtime errors are ignored there.
				const lastError = this.lastServerError;
				if (lastError) {
					try {
						ws.send(lastError);
					} catch {
						// Ignore send errors
					}
				}
				return;
			}

			if (data.type === 'collab-join') {
				if (att.kind !== 'ide') {
					try {
						ws.close(1008, 'Forbidden');
					} catch {
						// Ignore close errors
					}
					return;
				}
				att.joined = true;
				this.setAttachment(ws, att);
				const runtimeStatus = this.ctx.storage.kv.get<RuntimeStatus>('project-runtime-status');
				if (runtimeStatus) ws.send(serializeMessage({ type: 'runtime-status', status: runtimeStatus }));

				// Send initial collab state with active agent session (if any).
				// The agent status query is async, so we send the base state first
				// and include agent status if we can fetch it quickly.
				void this.sendCollabState(ws, att);

				// Replay last server-error to late-joining clients
				const lastError = this.lastServerError;
				if (lastError) {
					try {
						ws.send(lastError);
					} catch {
						// Ignore send errors
					}
				}
				if (att.collaborationVisible) {
					this.sendToOtherVisibleParticipants(
						ws,
						serializeMessage({
							type: 'participant-joined',
							participant: {
								id: att.id,
								color: att.color,
								file: att.file,
								cursor: att.cursor,
								selection: att.selection,
							},
						}),
					);
				}
				return;
			}

			if (data.type === 'cursor-update') {
				if (att.kind !== 'ide') return;
				if (!att?.joined) return;
				att.file = data.file;
				att.cursor = data.cursor;
				att.selection = data.selection;
				this.setAttachment(ws, att);
				if (att.collaborationVisible) {
					this.sendToOtherVisibleParticipants(
						ws,
						serializeMessage({
							type: 'cursor-updated',
							id: att.id,
							color: att.color,
							file: att.file,
							cursor: att.cursor,
							selection: att.selection,
						}),
					);
				}
				return;
			}

			if (data.type === 'file-edit') {
				if (att.kind !== 'ide') return;
				if (!att?.joined) return;
				att.file = data.path;
				att.cursor = data.cursor;
				att.selection = data.selection;
				this.setAttachment(ws, att);
				this.sendToOtherJoinedIdeSockets(
					ws,
					serializeMessage({
						type: 'file-edited',
						id: att.id,
						path: data.path,
						content: data.content,
						cursor: data.cursor,
						selection: data.selection,
					}),
				);
				this.appendRecentExternalChange({ kind: 'file-edit', path: data.path, timestamp: Date.now() });
				return;
			}

			if (data.type === 'output-logs-sync') {
				if (att.kind !== 'ide') return;
				this.outputLogs = data.logs;
				return;
			}
		} catch {
			// Ignore parse errors
		}
	}

	webSocketClose(ws: WebSocket, code: number, reason: string): void {
		const att = this.getAttachment(ws);
		if (this.isVisibleJoinedIdeAttachment(att)) {
			this.sendToOtherVisibleParticipants(
				ws,
				serializeMessage({
					type: 'participant-left',
					id: att.id,
				}),
			);
		}

		const remainingConnections = this.ctx.getWebSockets().filter((s) => s !== ws && s.readyState === WebSocket.OPEN).length;

		trackWebSocketEvent({
			projectId: this.projectId ?? this.ctx.id.toString(),
			eventType: 'disconnect',
			connectionType: 'coordinator',
			concurrentConnections: remainingConnections,
		});

		try {
			ws.close(code, reason);
		} catch {
			// Ignore close errors
		}
	}

	webSocketError(ws: WebSocket): void {
		const att = this.getAttachment(ws);
		if (this.isVisibleJoinedIdeAttachment(att)) {
			this.sendToOtherVisibleParticipants(
				ws,
				serializeMessage({
					type: 'participant-left',
					id: att.id,
				}),
			);
		}
		try {
			ws.close(1011, 'WebSocket error');
		} catch {
			// Ignore close errors
		}
	}
}
