import { afterEach, describe, expect, it, vi } from 'vitest';

import { ComputerOutputObserver, ComputerOutputPublisher } from './computer-output-observer';

describe('best effort command progress', () => {
	afterEach(() => vi.useRealTimers());
	it('batches replacements while execution is still pending', async () => {
		vi.useFakeTimers();
		const receive = vi.fn(async () => {});
		const background: Promise<void>[] = [];
		const publisher = new ComputerOutputPublisher(new ComputerOutputObserver(receive), (promise) => {
			background.push(promise);
		});
		for (const stdout of ['a', 'ab', 'abc'])
			publisher.publish({ executionId: 'one', stdout, stderr: '', stdoutBytes: stdout.length, stderrBytes: 0, truncated: false });
		expect(receive).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(100);
		await Promise.all(background);
		expect(receive).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ stdout: 'abc' }));
	});
	it('disables disconnected or stalled observers without blocking the caller', async () => {
		vi.useFakeTimers();
		const receive = vi.fn(() => new Promise<void>(() => {}));
		const background: Promise<void>[] = [];
		const publisher = new ComputerOutputPublisher(new ComputerOutputObserver(receive), (promise) => {
			background.push(promise);
		});
		const output = { executionId: 'one', stdout: 'a', stderr: '', stdoutBytes: 1, stderrBytes: 0, truncated: false };
		publisher.publish(output);
		publisher.flush();
		publisher.publish({ ...output, stdout: 'new' });
		await vi.advanceTimersByTimeAsync(2100);
		await Promise.all(background);
		publisher.flush();
		expect(receive).toHaveBeenCalledOnce();
	});
});
