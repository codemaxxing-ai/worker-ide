import type { WorkspaceRuntimeExecHandle } from '@cloudflare/computer';

/** Consume command output without allocating an unbounded result buffer. */
export async function drainComputerOutput(handle: WorkspaceRuntimeExecHandle<'utf8'>, heartbeat: () => Promise<void>) {
	let stdout = '';
	let stderr = '';
	let stdoutBytes = 0;
	let stderrBytes = 0;
	let exitCode: number | undefined;
	let valueJson: string | undefined;
	const reader = handle.getReader();
	try {
		for (;;) {
			const event = await reader.read();
			if (event.done) break;
			if (event.value.name === 'exit') {
				exitCode = event.value.code;
				valueJson = event.value.result === undefined ? undefined : JSON.stringify(event.value.result);
				continue;
			}
			const bytes = new TextEncoder().encode(event.value.value);
			if (event.value.name === 'stdout') {
				stdout += new TextDecoder().decode(bytes.slice(0, Math.max(0, 60_000 - stdoutBytes)));
				stdoutBytes += bytes.length;
			} else {
				stderr += new TextDecoder().decode(bytes.slice(0, Math.max(0, 60_000 - stderrBytes)));
				stderrBytes += bytes.length;
			}
			await heartbeat();
		}
	} finally {
		reader.releaseLock();
	}
	if (exitCode === undefined) throw new Error('Command stream ended without a durable exit status');
	return { stdout, stderr, exitCode, valueJson };
}
