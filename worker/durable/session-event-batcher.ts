import type { StreamEvent } from '@shared/agent-state';

const FLUSH_INTERVAL_MS = 100;
const MAX_PENDING_CHARACTERS = 8192;

/** Bound RPC traffic by elapsed time and payload size, rather than token count. */
export class SessionEventBatcher {
	private pending: StreamEvent[] = [];
	private pendingCharacters = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private tail = Promise.resolve();
	private failure?: Error;

	constructor(
		private readonly send: (events: StreamEvent[]) => Promise<void>,
		private readonly waitUntil: (promise: Promise<void>) => void,
	) {}

	enqueue(events: StreamEvent[]): Promise<void> {
		if (this.failure) return Promise.reject(this.failure);
		let boundary = false;
		for (const event of events) {
			const last = this.pending.at(-1);
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
