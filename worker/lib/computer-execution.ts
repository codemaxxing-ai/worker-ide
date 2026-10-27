import { truncateOutput } from '@shared/command-output';

import type { WorkspaceRuntimeExecHandle } from '@cloudflare/computer';
import type { CommandOutput } from '@shared/command-output';

/** Consume command output without allocating an unbounded result buffer. */
export async function drainComputerOutput(
	handle: WorkspaceRuntimeExecHandle<'utf8'>,
	heartbeat: () => Promise<void>,
	progress?: (output: Omit<CommandOutput, 'executionId'>) => void,
) {
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
			const previousStdout = stdout;
			const previousStderr = stderr;
			const wasTruncated = stdoutBytes > 60_000 || stderrBytes > 60_000;
			const bytes = new TextEncoder().encode(event.value.value);
			if (event.value.name === 'stdout') {
				stdout += truncateOutput(event.value.value, Math.max(0, 60_000 - stdoutBytes));
				stdoutBytes += bytes.length;
			} else {
				stderr += truncateOutput(event.value.value, Math.max(0, 60_000 - stderrBytes));
				stderrBytes += bytes.length;
			}
			if (stdout !== previousStdout || stderr !== previousStderr || wasTruncated !== (stdoutBytes > 60_000 || stderrBytes > 60_000))
				progress?.({ stdout, stderr, stdoutBytes, stderrBytes, truncated: stdoutBytes > 60_000 || stderrBytes > 60_000 });
			await heartbeat();
		}
	} finally {
		reader.releaseLock();
	}
	if (exitCode === undefined) throw new Error('Command stream ended without a durable exit status');
	progress?.({ stdout, stderr, stdoutBytes, stderrBytes, truncated: stdoutBytes > 60_000 || stderrBytes > 60_000 });
	return { stdout, stderr, exitCode, valueJson };
}
