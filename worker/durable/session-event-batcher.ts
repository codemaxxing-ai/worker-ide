import { mergeCommandOutput } from '@shared/command-output';

import type { StreamEvent } from '@shared/agent-state';
import type { ToolCommandOutput } from '@shared/command-output';

const FLUSH_INTERVAL_MS = 100;
const MAX_PENDING_CHARACTERS = 8192;

/** Bound RPC traffic by elapsed time and payload size, rather than token count. */
export class SessionEventBatcher {
	private pending: StreamEvent[] = [];
	private pendingCharacters = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private tail = Promise.resolve();
	private failure?: Error;
	private outputs = new Map<string, ToolCommandOutput>();
	private completed = new Set<string>();

	completeTool(toolCallId: string): void {
		this.outputs.delete(toolCallId);
		this.completed.add(toolCallId);
		if (this.completed.size > 256) this.completed.delete(this.completed.values().next().value ?? '');
	}

	constructor(
		private readonly send: (events: StreamEvent[]) => Promise<void>,
		private readonly waitUntil: (promise: Promise<void>) => void,
	) {}

	enqueue(events: StreamEvent[]): Promise<void> {
		if (this.failure) return Promise.reject(this.failure);
		let boundary = false;
		for (let event of events) {
			const last = this.pending.at(-1);
			if (event.type === 'tool-output') {
				if (this.completed.has(event.toolCallId)) continue;
				const retained = mergeCommandOutput(this.outputs.get(event.toolCallId), event.output);
				this.outputs.set(event.toolCallId, retained);
				const executionId = event.output.executionId;
				const output = retained.executions.find((entry) => entry.executionId === executionId);
				event = {
					...event,
					output: output ?? { ...event.output, executionId: 'output-record-limit', stdout: '', stderr: '', truncated: true },
				};
				const outputEvent = event;
				const index = this.pending.findIndex(
					(pending) =>
						pending.type === 'tool-output' &&
						pending.toolCallId === outputEvent.toolCallId &&
						pending.output.executionId === outputEvent.output.executionId,
				);
				if (index === -1) {
					this.pending.push(event);
				} else {
					this.pending[index] = event;
				}
				continue;
			}
			if (event.type === 'text-delta' || event.type === 'reasoning-delta') {
				this.pendingCharacters += event.delta.length;
				if (last?.type === event.type) {
					last.delta += event.delta;
					continue;
				}
			} else if (event.type === 'tool-call-args-delta') {
				this.pendingCharacters += event.delta.length;
				if (last?.type === event.type && last.toolCallId === event.toolCallId) {
					last.delta += event.delta;
					continue;
				}
			} else {
				if (event.type === 'tool-call-end') this.completeTool(event.toolCallId);
				boundary = true;
			}
			this.pending.push({ ...event });
		}
		if (boundary || this.pendingCharacters >= MAX_PENDING_CHARACTERS) return this.flush();
		if (this.pending.length > 0 && this.timer === undefined) {
			this.timer = setTimeout(() => {
				this.timer = undefined;
				this.waitUntil(
					this.flush().catch((error) => {
						console.error('[SessionTurnAgent] Failed to flush streaming events:', error);
					}),
				);
			}, FLUSH_INTERVAL_MS);
		}
		return Promise.resolve();
	}

	flush(): Promise<void> {
		clearTimeout(this.timer);
		this.timer = undefined;
		if (this.pending.length === 0) return this.tail;
		const events = this.pending;
		this.pending = [];
		this.pendingCharacters = 0;
		this.tail = this.tail
			.then(() => this.send(events))
			.catch((error: unknown) => {
				this.failure = error instanceof Error ? error : new Error(String(error));
				throw this.failure;
			});
		return this.tail;
	}
}
