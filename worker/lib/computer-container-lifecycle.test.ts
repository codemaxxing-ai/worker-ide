import { afterEach, describe, expect, it, vi } from 'vitest';

import { destroyComputerContainer } from './computer-container-lifecycle';

function createContainer() {
	let stopped: (() => void) | undefined;
	const monitoring = new Promise<void>((resolve) => (stopped = resolve));
	const container = {
		running: true,
		monitor: vi.fn(() => monitoring),
		destroy: vi.fn<Container['destroy']>().mockResolvedValue(),
		signal: vi.fn<Container['signal']>(() => stopped?.()),
	};
	return { container, stopped: () => stopped?.() };
}

describe('Computer container destruction', () => {
	afterEach(() => vi.useRealTimers());
	it('waits for graceful shutdown before destroying the container', async () => {
		const { container, stopped } = createContainer();
		let disconnected: (() => void) | undefined;
		const workspace = { close: vi.fn(() => new Promise<void>((resolve) => (disconnected = resolve))) };
		container.signal.mockImplementation(() => {
			expect(workspace.close).toHaveBeenCalledOnce();
			expect(container.destroy).not.toHaveBeenCalled();
		});
		const destroying = destroyComputerContainer(container, workspace);
		await Promise.resolve();
		expect(container.signal).not.toHaveBeenCalled();
		disconnected?.();
		await Promise.resolve();
		expect(container.signal).toHaveBeenCalledExactlyOnceWith(15);
		expect(container.destroy).not.toHaveBeenCalled();
		stopped();
		await destroying;
		expect(container.destroy).toHaveBeenCalledOnce();
	});
	it('retains the container when disconnecting the workspace fails', async () => {
		const { container } = createContainer();
		const workspace = { close: vi.fn<() => Promise<void>>().mockRejectedValue(new Error('Disconnect failed')) };
		await expect(destroyComputerContainer(container, workspace)).rejects.toThrow('Disconnect failed');
		expect(container.signal).not.toHaveBeenCalled();
		expect(container.destroy).not.toHaveBeenCalled();
	});
	it('accepts the monitor rejection caused by a signaled exit', async () => {
		const { container } = createContainer();
		container.monitor.mockRejectedValue(new Error('Container exited with code 143'));
		await destroyComputerContainer(container);
		expect(container.destroy).toHaveBeenCalledOnce();
	});
	it('bounds graceful shutdown before forcing destruction', async () => {
		vi.useFakeTimers();
		const { container } = createContainer();
		container.signal.mockImplementation(() => {});
		const destroying = destroyComputerContainer(container);
		await vi.advanceTimersByTimeAsync(4999);
		expect(container.destroy).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await destroying;
		expect(container.destroy).toHaveBeenCalledOnce();
	});
	it('preserves destruction errors so storage is retained for retry', async () => {
		const { container } = createContainer();
		container.destroy.mockRejectedValue(new Error('Docker unavailable'));
		await expect(destroyComputerContainer(container)).rejects.toThrow('Docker unavailable');
	});
	it('does not start or signal an absent or stopped container', async () => {
		const { container } = createContainer();
		container.running = false;
		await destroyComputerContainer();
		await destroyComputerContainer(container);
		expect(container.signal).not.toHaveBeenCalled();
		expect(container.destroy).not.toHaveBeenCalled();
	});
});
