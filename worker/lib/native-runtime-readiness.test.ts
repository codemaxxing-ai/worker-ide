import { afterEach, describe, expect, it, vi } from 'vitest';

import { waitForNativeRuntime } from './native-runtime-readiness';

describe('native manager readiness', () => {
	afterEach(() => vi.useRealTimers());
	it('accepts a listening manager from the previous deployment', async () => {
		await expect(waitForNativeRuntime(async () => new Response('Not found', { status: 404 }))).resolves.toBeUndefined();
	});
	it('waits for the HTTP manager after the container shell is already reachable', async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<Response>>()
			.mockRejectedValueOnce(new Error('Container is not listening to port 8788'))
			.mockRejectedValueOnce(new Error('Container is not listening to port 8788'))
			.mockResolvedValue(new Response('Ready'));
		const waiting = waitForNativeRuntime(request);
		await vi.advanceTimersByTimeAsync(250);
		await waiting;
		expect(request).toHaveBeenCalledTimes(3);
	});
	it('bounds startup waiting and leaves other errors intact', async () => {
		vi.useFakeTimers();
		const request = vi.fn<() => Promise<Response>>().mockRejectedValue(new Error('Container is not listening to port 8788'));
		const rejected = expect(waitForNativeRuntime(request, 200)).rejects.toThrow('not listening');
		await vi.advanceTimersByTimeAsync(300);
		await rejected;
		const failed = vi.fn<() => Promise<Response>>().mockRejectedValue(new Error('Workspace recovery required'));
		await expect(waitForNativeRuntime(failed)).rejects.toThrow('Workspace recovery required');
		expect(failed).toHaveBeenCalledOnce();
	});
});
