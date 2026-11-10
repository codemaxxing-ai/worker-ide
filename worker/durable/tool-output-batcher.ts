import { mergeCommandOutput } from '@shared/command-output';

import type { ToolOutputEvent } from '@shared/agent-state';
import type { ToolCommandOutput } from '@shared/command-output';

const FLUSH_INTERVAL_MS = 100;

/** Bounded command snapshots for native delegated-run progress. */
export class ToolOutputBatcher {
	private pending: ToolOutputEvent[] = [];
	private timer?: ReturnType<typeof setTimeout>;
	private tail = Promise.resolve();
	private failure?: Error;
	private outputs = new Map<string, ToolCommandOutput>();
	constructor(
		private readonly send: (events: ToolOutputEvent[]) => Promise<void>,
		private readonly waitUntil: (promise: Promise<void>) => void,
	) {}

	enqueue(events: ToolOutputEvent[]): Promise<void> {
		if (this.failure) return Promise.reject(this.failure);
		for (let event of events) {
			if (event.type === 'tool-output') {
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
		}

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
		this.tail = this.tail
			.then(() => this.send(events))
			.catch((error: unknown) => {
				this.failure = error instanceof Error ? error : new Error(String(error));
				throw this.failure;
			});
		return this.tail;
	}
}
