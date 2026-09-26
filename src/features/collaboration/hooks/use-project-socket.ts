import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { toast } from '@/components/ui/toast-store';
import { connectProjectSocket } from '@/lib/api-client';
import { emitEditorEvent } from '@/lib/editor-events';
import { checkProjectAccess, invalidateProjectAccess } from '@/lib/project-access';
import { flushProjectSaveQueue } from '@/lib/queued-save-flush';
import { useStore } from '@/lib/store';
import { mergeTestRunResults } from '@shared/types';

import type { TestRunResponse } from '@shared/types';
import type { ClientMessage } from '@shared/ws-messages';

interface UseProjectSocketOptions {
	projectId: string;
	enabled?: boolean;
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 90_000;

/**
 * Hook for connecting to the project WebSocket and handling updates.
 *
 * Uses refs exclusively for callbacks to ensure the WebSocket connection
 * is only created/destroyed when projectId or enabled changes — never
 * due to callback identity churn.
 */
/**
 * Global ref for the WebSocket send function.
 * Used by the editor to send cursor updates without prop drilling.
 */
export const projectSocketSendReference: { current: ((data: ClientMessage) => void) | undefined } = { current: undefined };

function dispatchProjectUnavailable(projectId: string, status: 'not-found' | 'forbidden'): void {
	globalThis.dispatchEvent(new CustomEvent('project-unavailable', { detail: { projectId, status } }));
}

function invalidateReconnectState(queryClient: ReturnType<typeof useQueryClient>, projectId: string): void {
	void queryClient.invalidateQueries({ queryKey: ['files', projectId] });
	void queryClient.invalidateQueries({ queryKey: ['git-status', projectId] });
	void queryClient.invalidateQueries({ queryKey: ['git-branches', projectId] });
	void queryClient.invalidateQueries({ queryKey: ['git-log', projectId] });
	void queryClient.invalidateQueries({ queryKey: ['project-deps', projectId] });
	void queryClient.invalidateQueries({ queryKey: ['project-settings', projectId] });
	void queryClient.invalidateQueries({ queryKey: ['project-meta', projectId] });

	// The file-content cache is the single source of on-disk truth. Always
	// refresh every cached file after a reconnect; in-flight local edits live
	// in the editor's own buffer (localEditorContent) and take precedence over
	// a background refetch, so there is nothing to protect here.
	const fileQueries = queryClient.getQueryCache().findAll({ queryKey: ['file', projectId] });
	for (const query of fileQueries) {
		const filePath = query.queryKey[2];
		if (typeof filePath !== 'string') continue;

		void queryClient.invalidateQueries({ queryKey: ['file', projectId, filePath], exact: true });
	}
}

export function useProjectSocket({ projectId, enabled = true }: UseProjectSocketOptions) {
	const queryClient = useQueryClient();
	const storeActions = useStore(
		useShallow((state) => ({
			setParticipants: state.setParticipants,
			addParticipant: state.addParticipant,
			removeParticipant: state.removeParticipant,
			updateParticipant: state.updateParticipant,
			setLocalParticipantId: state.setLocalParticipantId,
			setLocalParticipantColor: state.setLocalParticipantColor,
			setConnected: state.setConnected,
		})),
	);

	// All mutable state in refs — none of these cause re-connection
	const reconnectTimeoutReference = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const reconnectAttemptsReference = useRef(0);
	const connectionReference = useRef<import('@/lib/api-client').ProjectSocketConnection | undefined>(undefined);
	const heartbeatIntervalReference = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
	const lastPongAtReference = useRef(0);
	const hasOpenedReference = useRef(false);
	const queryClientReference = useRef(queryClient);
	const storeActionsReference = useRef(storeActions);
	const projectIdReference = useRef(projectId);
	const isMountedReference = useRef(true);

	// Keep refs in sync (runs every render but does NOT trigger effects)
	useEffect(() => {
		queryClientReference.current = queryClient;
		storeActionsReference.current = storeActions;
		projectIdReference.current = projectId;
	});

	// Single effect: connect on mount / when projectId or enabled changes
	useEffect(() => {
		if (!enabled) return;

		isMountedReference.current = true;
		hasOpenedReference.current = false;

		const stopHeartbeat = () => {
			if (heartbeatIntervalReference.current) {
				clearInterval(heartbeatIntervalReference.current);
				heartbeatIntervalReference.current = undefined;
			}
		};

		const startHeartbeat = () => {
			stopHeartbeat();
			lastPongAtReference.current = Date.now();
			heartbeatIntervalReference.current = setInterval(() => {
				const connection = connectionReference.current;
				if (!connection) return;

				if (Date.now() - lastPongAtReference.current > HEARTBEAT_TIMEOUT_MS) {
					connection.close(4000, 'heartbeat-timeout');
					return;
				}

				connection.send({ type: 'ping' });
			}, HEARTBEAT_INTERVAL_MS);
		};

		const doConnect = () => {
			const connectedProjectId = projectId;

			// Bail out if unmounted between reconnect timeout and execution
			if (!isMountedReference.current) return;

			// Tear down any existing connection
			connectionReference.current?.cleanup();
			stopHeartbeat();
			if (reconnectTimeoutReference.current) {
				clearTimeout(reconnectTimeoutReference.current);
				reconnectTimeoutReference.current = undefined;
			}

			connectionReference.current = connectProjectSocket(
				projectId,
				// onMessage — reads latest refs each invocation
				(message) => {
					const { setParticipants, addParticipant, removeParticipant, updateParticipant, setLocalParticipantId, setLocalParticipantColor } =
						storeActionsReference.current;
					const queryClientCurrent = queryClientReference.current;
					const projectIdCurrent = projectIdReference.current;

					switch (message.type) {
						case 'update':
						case 'full-reload': {
							// Invalidate the content query for every updated path,
							// including the active file. The file-content cache is the
							// single source of on-disk truth, so agent / collaborator
							// writes must always load into it; the editor's in-flight
							// typing buffer (localEditorContent) takes precedence over a
							// background refetch, so there is nothing to protect here.
							let configFileChanged = false;
							for (const update of message.updates) {
								if (update.path === '/package.json' || update.path === '/wrangler.jsonc') {
									configFileChanged = true;
								}
								void queryClientCurrent.invalidateQueries({
									queryKey: ['file', projectIdCurrent, update.path],
								});
							}
							// Refresh the file list so newly created/deleted files
							// by the AI agent or collaborators appear immediately.
							void queryClientCurrent.invalidateQueries({
								queryKey: ['files', projectIdCurrent],
							});
							// When package.json or wrangler.jsonc changed, refresh derived
							// query caches so the dependencies panel and settings update
							// immediately without waiting for their stale times to expire.
							if (configFileChanged) {
								void queryClientCurrent.invalidateQueries({
									queryKey: ['project-deps', projectIdCurrent],
								});
								void queryClientCurrent.invalidateQueries({
									queryKey: ['project-settings', projectIdCurrent],
								});
								void queryClientCurrent.invalidateQueries({
									queryKey: ['project-meta', projectIdCurrent],
								});
							}
							// full-reload is sent for structural changes (file delete,
							// move, git checkout) that cannot be reconciled through the
							// module graph runtime inside the preview iframe, so force a
							// top-level iframe refresh from the parent.
							if (message.type === 'full-reload') {
								emitEditorEvent('preview-force-refresh');
							}
							// Notify the log buffer that a rebuild occurred
							emitEditorEvent('rebuild');
							break;
						}
						case 'file-edited': {
							queryClientCurrent.setQueryData(['file', projectIdCurrent, message.path], {
								path: message.path,
								content: message.content,
							});
							if (message.cursor || message.selection) {
								updateParticipant(message.id, {
									file: message.path,
									cursor: message.cursor,
									selection: message.selection,
								});
							}
							useStore.setState((state) => {
								if (state.gitDiffView?.path !== message.path) {
									return {};
								}

								return { gitDiffView: { ...state.gitDiffView, afterContent: message.content } };
							});
							break;
						}
						case 'collab-state': {
							setParticipants(message.participants);
							if ('selfId' in message && typeof message.selfId === 'string') {
								setLocalParticipantId(message.selfId);
							}
							if ('selfColor' in message && typeof message.selfColor === 'string') {
								setLocalParticipantColor(message.selfColor);
							}
							break;
						}
						case 'participant-joined': {
							addParticipant(message.participant);
							break;
						}
						case 'participant-left': {
							removeParticipant(message.id);
							break;
						}
						case 'server-error': {
							emitEditorEvent('server-error', message.error);
							break;
						}

						case 'server-logs': {
							emitEditorEvent('server-logs', message.logs);
							break;
						}
						case 'cursor-updated': {
							updateParticipant(message.id, {
								file: message.file,
								cursor: message.cursor,
								selection: message.selection,
							});
							break;
						}
						case 'git-status-changed': {
							// Invalidate git queries so the UI refreshes
							void queryClientCurrent.invalidateQueries({
								queryKey: ['git-status', projectIdCurrent],
							});
							void queryClientCurrent.invalidateQueries({
								queryKey: ['git-branches', projectIdCurrent],
							});
							void queryClientCurrent.invalidateQueries({
								queryKey: ['git-log', projectIdCurrent],
							});
							break;
						}
						case 'test-results-changed': {
							// Update local test results cache with the broadcast data.
							// For single-test runs, merge into existing results so other
							// tests are not lost.
							if (message.pattern) {
								const existing = queryClientCurrent.getQueryData<TestRunResponse>(['test-results', projectIdCurrent]);
								if (existing) {
									queryClientCurrent.setQueryData(['test-results', projectIdCurrent], mergeTestRunResults(existing, message.results));
									break;
								}
							}
							queryClientCurrent.setQueryData(['test-results', projectIdCurrent], message.results);
							break;
						}
						case 'pong': {
							lastPongAtReference.current = Date.now();
							break;
						}
					}
				},
				// onClose — only fires for unexpected disconnects (intentional
				// closes are suppressed by the connectProjectSocket cleanup function)
				(details) => {
					if (!isMountedReference.current) return;

					stopHeartbeat();
					storeActionsReference.current.setConnected(false);

					if (details.code === 4004 && details.reason === 'project-deleted') {
						void (async () => {
							invalidateProjectAccess(connectedProjectId);
							try {
								const status = await checkProjectAccess(connectedProjectId);
								if (!isMountedReference.current) {
									return;
								}
								if (status === 'not-found' || status === 'forbidden') {
									dispatchProjectUnavailable(connectedProjectId, status);
									return;
								}
							} catch {
								dispatchProjectUnavailable(connectedProjectId, 'not-found');
							}
						})();
						return;
					}

					const maxAttempts = 10;
					const baseDelay = 2000;
					if (reconnectAttemptsReference.current < maxAttempts) {
						const jitter = Math.floor(Math.random() * 1000);
						const delay = Math.min(baseDelay * 2 ** reconnectAttemptsReference.current + jitter, 30_000);
						reconnectTimeoutReference.current = setTimeout(() => {
							reconnectAttemptsReference.current++;
							doConnect();
						}, delay);
					} else {
						toast.error('Lost connection to the server. Real-time features are unavailable. Please reload the page to reconnect.', {
							duration: 15_000,
						});
					}
				},
				// onOpen
				() => {
					const isReconnect = hasOpenedReference.current;
					hasOpenedReference.current = true;
					storeActionsReference.current.setConnected(true);
					reconnectAttemptsReference.current = 0;
					projectSocketSendReference.current = connectionReference.current?.send;
					startHeartbeat();

					const projectIdCurrent = projectIdReference.current;
					const queryClientCurrent = queryClientReference.current;
					void flushProjectSaveQueue({ projectId: projectIdCurrent, queryClient: queryClientCurrent });
					if (isReconnect) {
						invalidateReconnectState(queryClientCurrent, projectIdCurrent);
					}
				},
			);
		};

		doConnect();

		return () => {
			isMountedReference.current = false;
			connectionReference.current?.cleanup();
			stopHeartbeat();
			connectionReference.current = undefined;
			projectSocketSendReference.current = undefined;
			if (reconnectTimeoutReference.current) {
				clearTimeout(reconnectTimeoutReference.current);
				reconnectTimeoutReference.current = undefined;
			}
			storeActionsReference.current.setConnected(false);
		};
		// Intentionally only depends on projectId and enabled.
		// All other values are read from refs inside the closures.
	}, [enabled, projectId]);
}
