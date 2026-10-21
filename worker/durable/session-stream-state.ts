import { parsePartialJson } from 'ai';

import { clearSnapshotFromMessages, setSnapshotOnLastCommittedUserMessage } from './session-history';
import { accumulatePendingChange } from '../services/agent/pending-changes';

import type { AgentSessionState, StreamEvent } from '@shared/agent-state';
import type { PushNotification } from '@shared/notification-types';
import type { AiSession, ChatMessage, MessagePart } from '@shared/types';

interface SessionStreamStateHost {
	getCurrentSession(): AgentSessionState | undefined;
	updateSessionState(sessionId: string, patch: Partial<AgentSessionState>): void;
	readSession(sessionId: string): Promise<AiSession | undefined>;
	getSessionInitiatorUserId(sessionId: string): string | undefined;
	sendPushNotification(userId: string, notification: PushNotification): void;
	recordToolCall(sessionId: string): void;
	recordTurnComplete(sessionId: string): void;
	recordUsage(sessionId: string, inputTokens: number, outputTokens: number): void;
}

export class SessionStreamState {
	private toolCallArgumentBuffers = new Map<string, Map<string, string>>();
	private currentRunSnapshotIds = new Map<string, string>();
	private pendingContentDeltas = new Map<string, { type: 'reasoning' | 'text'; content: string }>();
	private contentFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private pendingSubAgentDeltas = new Map<string, Map<string, string>>();
	private subAgentDeltaFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(private host: SessionStreamStateHost) {}

	async handleEvent(sessionId: string, event: StreamEvent): Promise<void> {
		if (this.host.getCurrentSession()?.sessionId !== sessionId) {
			return;
		}

		switch (event.type) {
			case 'status': {
				this.host.updateSessionState(sessionId, { statusText: event.message });
				break;
			}
			case 'context-utilization': {
				this.host.updateSessionState(sessionId, { contextTokensUsed: event.estimatedTokens });
				break;
			}
			case 'snapshot-created': {
				this.currentRunSnapshotIds.set(sessionId, event.id);
				const current = this.host.getCurrentSession();
				if (current) {
					const messages = setSnapshotOnLastCommittedUserMessage(current.messages, event.id);
					if (messages !== current.messages) {
						this.host.updateSessionState(sessionId, { messages });
					}
				}
				break;
			}
			case 'snapshot-deleted': {
				this.currentRunSnapshotIds.delete(sessionId);
				const current = this.host.getCurrentSession();
				if (!current) {
					break;
				}
				const messages = clearSnapshotFromMessages(current.messages, event.id);
				if (messages !== current.messages) {
					this.host.updateSessionState(sessionId, { messages });
				}
				break;
			}
			case 'file-changed': {
				if (event.action === 'create' || event.action === 'edit' || event.action === 'delete' || event.action === 'move') {
					const current = this.host.getCurrentSession();
					if (current) {
						const changesMap = new Map(Object.entries(current.pendingChanges));
						accumulatePendingChange(changesMap, {
							path: event.path,
							isBinary: event.isBinary,
							entryType: event.entryType,
							beforeEntryType: event.beforeEntryType,
							action: event.action,
							beforeContent: event.beforeContent,
							afterContent: event.afterContent,
							snapshotId: this.currentRunSnapshotIds.get(sessionId),
							sessionId,
						});
						this.host.updateSessionState(sessionId, { pendingChanges: Object.fromEntries(changesMap) });
					}
				}
				break;
			}
			case 'tool-result': {
				const current = this.host.getCurrentSession();
				if (!current) {
					break;
				}
				this.host.updateSessionState(sessionId, {
					toolMetadata: {
						...current.toolMetadata,
						[event.toolCallId]: {
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							title: event.title,
							metadata: event.metadata,
						},
					},
				});
				break;
			}
			case 'tool-error': {
				const current = this.host.getCurrentSession();
				if (!current) break;
				this.host.updateSessionState(sessionId, {
					toolErrors: {
						...current.toolErrors,
						[event.toolCallId]: {
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							errorCode: event.errorCode,
							errorMessage: event.errorMessage,
						},
					},
				});
				break;
			}
			case 'turn-complete': {
				this.flushContentDelta(sessionId);
				this.toolCallArgumentBuffers.delete(sessionId);
				const session = await this.host.readSession(sessionId);
				if (session && this.host.getCurrentSession()?.sessionId === sessionId) {
					const current = this.host.getCurrentSession();
					this.host.updateSessionState(sessionId, {
						messages: [],
						historyVersion: (current?.historyVersion ?? 0) + 1,
						toolMetadata: {},
						toolErrors: {},
						subAgentActivities: {},
						stopRequested: session.stopRequested ?? false,
					});
				}
				this.host.recordTurnComplete(sessionId);
				break;
			}
			case 'steering-message-committed': {
				break;
			}
			case 'reasoning-delta': {
				this.accumulateContentDelta(sessionId, 'reasoning', event.delta);
				break;
			}
			case 'text-delta': {
				this.accumulateContentDelta(sessionId, 'text', event.delta);
				break;
			}
			case 'tool-call-start': {
				this.flushContentDelta(sessionId);
				const messages = this.appendToStreamingAssistantMessage(sessionId, (parts) => {
					parts.push({
						type: 'tool-call',
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						arguments: {},
					});
				});
				if (messages) {
					this.host.updateSessionState(sessionId, { messages });
				}
				this.host.recordToolCall(sessionId);
				break;
			}
			case 'tool-call-args-delta': {
				let sessionBuffers = this.toolCallArgumentBuffers.get(sessionId);
				if (!sessionBuffers) {
					sessionBuffers = new Map();
					this.toolCallArgumentBuffers.set(sessionId, sessionBuffers);
				}
				const buffer = (sessionBuffers.get(event.toolCallId) ?? '') + event.delta;
				sessionBuffers.set(event.toolCallId, buffer);

				try {
					const { value: parsed } = await parsePartialJson(buffer);
					if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
						const current = this.host.getCurrentSession();
						if (!current) {
							break;
						}
						const messages = [...current.messages];
						const last = messages.at(-1);
						if (last?.role === 'assistant') {
							const parts = [...last.parts];
							const partIndex = parts.findLastIndex((part) => part.type === 'tool-call' && part.toolCallId === event.toolCallId);
							if (partIndex !== -1 && parts[partIndex]?.type === 'tool-call') {
								parts[partIndex] = {
									...parts[partIndex],
									arguments: Object.fromEntries(Object.entries(parsed)),
								};
								messages[messages.length - 1] = { ...last, parts };
								this.host.updateSessionState(sessionId, { messages });
							}
						}
					}
				} catch {
					// Wait for enough input to form an object.
				}
				break;
			}
			case 'tool-call-end': {
				this.flushContentDelta(sessionId);
				this.toolCallArgumentBuffers.get(sessionId)?.delete(event.toolCallId);
				const messages = this.appendToStreamingAssistantMessage(sessionId, (parts) => {
					parts.push({
						type: 'tool-result',
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						result: event.result ?? '',
						isError: event.isError,
					});
				});
				if (messages) {
					this.host.updateSessionState(sessionId, { messages });
				}
				break;
			}
			case 'user-question': {
				this.host.updateSessionState(sessionId, {
					pendingQuestion: { question: event.question, options: event.options },
				});
				const questionInitiatorUserId = this.host.getSessionInitiatorUserId(sessionId);
				if (questionInitiatorUserId) {
					this.host.sendPushNotification(questionInitiatorUserId, {
						tag: sessionId,
						title: 'Agent needs your input',
						body: event.question,
						urgency: 'high',
					});
				}
				break;
			}
			case 'max-iterations-reached': {
				this.host.updateSessionState(sessionId, { needsContinuation: true });
				break;
			}
			case 'doom-loop-detected': {
				this.host.updateSessionState(sessionId, { doomLoopMessage: event.message });
				break;
			}
			case 'sub-agent-activity': {
				const current = this.host.getCurrentSession();
				if (!current) {
					break;
				}
				const parentId = event.parentToolCallId;
				if (event.activity.kind === 'text-delta') {
					this.accumulateSubAgentDelta(sessionId, parentId, event.activity.delta);
					break;
				}
				if (event.activity.kind === 'reasoning-delta') {
					// Keep-alive only (resets the parent run's stall timer upstream);
					// sub-agent reasoning is not surfaced in the activity record.
					break;
				}
				if (event.activity.kind === 'tool-start' || (event.activity.kind === 'tool-end' && !event.activity.isError)) {
					break;
				}
				this.flushSubAgentDeltas(sessionId);
				const reloadedCurrent = this.host.getCurrentSession();
				if (!reloadedCurrent) {
					break;
				}
				const activities = { ...reloadedCurrent.subAgentActivities };
				const existing = activities[parentId] ?? { tools: [], debugLogId: undefined, streamingText: undefined };
				switch (event.activity.kind) {
					case 'debug-log': {
						activities[parentId] = { ...existing, debugLogId: event.activity.debugLogId };
						break;
					}
					case 'tool-metadata': {
						activities[parentId] = {
							...existing,
							tools: [
								...existing.tools,
								{
									toolName: event.activity.toolName,
									title: event.activity.title,
									metadata: event.activity.metadata,
									isError: typeof event.activity.metadata.error === 'string' && event.activity.metadata.error.length > 0,
								},
							],
						};
						break;
					}
					case 'tool-end': {
						activities[parentId] = {
							...existing,
							tools: [...existing.tools, { toolName: event.activity.toolName, title: 'Error', metadata: {}, isError: true }],
						};
						break;
					}
					default: {
						break;
					}
				}
				this.host.updateSessionState(sessionId, { subAgentActivities: activities });
				break;
			}
			case 'usage': {
				this.host.recordUsage(sessionId, event.input, event.output);
				break;
			}
			default: {
				break;
			}
		}
	}

	disposeSession(sessionId: string): void {
		this.flushContentDelta(sessionId);
		this.flushSubAgentDeltas(sessionId);
		this.toolCallArgumentBuffers.delete(sessionId);
		this.currentRunSnapshotIds.delete(sessionId);
	}

	private appendToStreamingAssistantMessage(sessionId: string, mutate: (parts: MessagePart[]) => void): ChatMessage[] | undefined {
		const current = this.host.getCurrentSession();
		if (!current || current.sessionId !== sessionId) {
			return undefined;
		}

		const messages = [...current.messages];
		const last = messages.at(-1);
		if (last?.role === 'assistant') {
			const parts = [...last.parts];
			mutate(parts);
			messages[messages.length - 1] = { ...last, parts };
		} else {
			const parts: MessagePart[] = [];
			mutate(parts);
			messages.push({
				id: crypto.randomUUID(),
				role: 'assistant',
				parts,
				createdAt: Date.now(),
			});
		}

		return messages;
	}

	private flushContentDelta(sessionId: string): void {
		const timer = this.contentFlushTimers.get(sessionId);
		if (timer) {
			clearTimeout(timer);
			this.contentFlushTimers.delete(sessionId);
		}

		const pending = this.pendingContentDeltas.get(sessionId);
		if (!pending) {
			return;
		}
		this.pendingContentDeltas.delete(sessionId);

		const messages = this.appendToStreamingAssistantMessage(sessionId, (parts) => {
			const lastPart = parts.at(-1);
			if (lastPart?.type === pending.type) {
				parts[parts.length - 1] = { ...lastPart, content: lastPart.content + pending.content };
				return;
			}
			if (pending.type === 'reasoning') {
				parts.push({ type: 'reasoning', content: pending.content });
				return;
			}
			parts.push({ type: 'text', content: pending.content });
		});
		if (messages) {
			this.host.updateSessionState(sessionId, { messages });
		}
	}

	private accumulateContentDelta(sessionId: string, type: 'reasoning' | 'text', content: string): void {
		const pending = this.pendingContentDeltas.get(sessionId);
		if (pending && pending.type !== type) {
			this.flushContentDelta(sessionId);
		}

		const current = this.pendingContentDeltas.get(sessionId);
		if (current) {
			current.content += content;
		} else {
			this.pendingContentDeltas.set(sessionId, { type, content });
		}

		if (!this.contentFlushTimers.has(sessionId)) {
			this.contentFlushTimers.set(
				sessionId,
				setTimeout(() => {
					this.contentFlushTimers.delete(sessionId);
					this.flushContentDelta(sessionId);
				}, 50),
			);
		}
	}

	private flushSubAgentDeltas(sessionId: string): void {
		const timer = this.subAgentDeltaFlushTimers.get(sessionId);
		if (timer) {
			clearTimeout(timer);
			this.subAgentDeltaFlushTimers.delete(sessionId);
		}

		const sessionDeltas = this.pendingSubAgentDeltas.get(sessionId);
		if (!sessionDeltas || sessionDeltas.size === 0) {
			return;
		}

		const current = this.host.getCurrentSession();
		if (!current || current.sessionId !== sessionId) {
			this.pendingSubAgentDeltas.delete(sessionId);
			return;
		}

		const activities = { ...current.subAgentActivities };
		for (const [parentId, delta] of sessionDeltas) {
			const existing = activities[parentId] ?? { tools: [], debugLogId: undefined, streamingText: undefined };
			activities[parentId] = {
				...existing,
				streamingText: (existing.streamingText ?? '') + delta,
			};
		}

		this.pendingSubAgentDeltas.delete(sessionId);
		this.host.updateSessionState(sessionId, { subAgentActivities: activities });
	}

	private accumulateSubAgentDelta(sessionId: string, parentToolCallId: string, delta: string): void {
		let sessionDeltas = this.pendingSubAgentDeltas.get(sessionId);
		if (!sessionDeltas) {
			sessionDeltas = new Map();
			this.pendingSubAgentDeltas.set(sessionId, sessionDeltas);
		}
		sessionDeltas.set(parentToolCallId, (sessionDeltas.get(parentToolCallId) ?? '') + delta);

		if (!this.subAgentDeltaFlushTimers.has(sessionId)) {
			this.subAgentDeltaFlushTimers.set(
				sessionId,
				setTimeout(() => {
					this.subAgentDeltaFlushTimers.delete(sessionId);
					this.flushSubAgentDeltas(sessionId);
				}, 50),
			);
		}
	}
}
