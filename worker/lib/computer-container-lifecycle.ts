import type { Workspace } from '@cloudflare/computer';

/** Close the RPC connection so computerd can shut down and unmount FUSE. */
export async function destroyComputerContainer(
	container?: Pick<Container, 'running' | 'monitor' | 'signal' | 'destroy'>,
	workspace?: Pick<Workspace, 'close'>,
): Promise<void> {
	await workspace?.close();
	if (!container?.running) return;
	const stopped = container.monitor().catch(() => {});
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		container.signal(15);
		await Promise.race([stopped, new Promise<void>((resolve) => (timeout = setTimeout(resolve, 5000)))]);
	} finally {
		clearTimeout(timeout);
	}
	await container.destroy();
}
