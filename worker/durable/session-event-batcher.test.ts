import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionEventBatcher } from './session-event-batcher';

import type { StreamEvent } from '@shared/agent-state';

describe('session event batching', () => {
	afterEach(() => vi.useRealTimers());

	it('coalesces fragmented arguments and flushes the last partial value without another model chunk', async () => {
		vi.useFakeTimers();
		const send = vi.fn(async (_events: StreamEvent[]) => {});
		const background: Promise<void>[] = [];
		const batcher = new SessionEventBatcher(send, (promise) => {
			background.push(promise);
		});
		for (const delta of ['{"path":', '"/src/', 'app.tsx"']) {
			await batcher.enqueue([{ type: 'tool-call-args-delta', toolCallId: 'edit', delta }]);
		}
		expect(send).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(100);
		await Promise.all(background);
		expect(send).toHaveBeenCalledExactlyOnceWith([{ type: 'tool-call-args-delta', toolCallId: 'edit', delta: '{"path":"/src/app.tsx"' }]);
	});

	it('preserves interleaved tools and control-event ordering', async () => {
		const send = vi.fn(async (_events: StreamEvent[]) => {});
		const batcher = new SessionEventBatcher(send, () => {});
		const events: StreamEvent[] = [
			{ type: 'tool-call-args-delta', toolCallId: 'first', delta: '{"path":' },
			{ type: 'tool-call-args-delta', toolCallId: 'second', delta: '{"content":' },
			{ type: 'tool-call-args-delta', toolCallId: 'first', delta: '"/app.tsx"}' },
			{ type: 'tool-call-start', toolCallId: 'first', toolName: 'edit', arguments: { path: '/app.tsx' } },
		];
		await batcher.enqueue(events);
		expect(send).toHaveBeenCalledExactlyOnceWith(events);
	});

	it('bounds pending data and waits for in-flight sends before a terminal flush', async () => {
		const first = Promise.withResolvers<void>();
		const sent: StreamEvent[][] = [];
		const batcher = new SessionEventBatcher(
			async (events) => {
				sent.push(events);
				if (sent.length === 1) await first.promise;
			},
			() => {},
		);
		const large = batcher.enqueue([{ type: 'text-delta', delta: 'x'.repeat(8192) }]);
		await batcher.enqueue([{ type: 'text-delta', delta: 'tail' }]);
		let finished = false;
		const terminal = batcher.flush().then(() => {
			finished = true;
		});
		await Promise.resolve();
		expect(finished).toBe(false);
		first.resolve();
		await Promise.all([large, terminal]);
		expect(sent).toEqual([[{ type: 'text-delta', delta: 'x'.repeat(8192) }], [{ type: 'text-delta', delta: 'tail' }]]);
	});

	it('surfaces a failed send instead of silently discarding the stream', async () => {
		const batcher = new SessionEventBatcher(
			async () => {
				throw new Error('RPC budget exhausted');
			},
			() => {},
		);
		await expect(batcher.enqueue([{ type: 'status', message: 'Working' }])).rejects.toThrow('RPC budget exhausted');
		await expect(batcher.enqueue([{ type: 'text-delta', delta: 'later' }])).rejects.toThrow('RPC budget exhausted');
		await expect(batcher.flush()).rejects.toThrow('RPC budget exhausted');
	});
});
