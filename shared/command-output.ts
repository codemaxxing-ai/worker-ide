export interface CommandOutput {
	executionId: string;
	stdout: string;
	stderr: string;
	stdoutBytes: number;
	stderrBytes: number;
	truncated: boolean;
	final?: boolean;
}

export interface ToolCommandOutput {
	executions: CommandOutput[];
	truncated: boolean;
}

export function truncateOutput(value: string, maximumBytes: number): string {
	const bytes = new TextEncoder().encode(value);
	if (bytes.length <= maximumBytes) return value;
	let end = Math.max(0, maximumBytes);
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return new TextDecoder().decode(bytes.subarray(0, end));
}

/** Cumulative snapshots are idempotent, including a recovered execution's full replay. */
export function mergeCommandOutput(previous: ToolCommandOutput | undefined, output: CommandOutput): ToolCommandOutput {
	const executions = previous?.executions ?? [];
	const index = executions.findIndex((entry) => entry.executionId === output.executionId);
	const existing = executions[index];
	if (existing?.final || (existing && (output.stdoutBytes < existing.stdoutBytes || output.stderrBytes < existing.stderrBytes)))
		return previous ?? { executions, truncated: false };
	if (index === -1 && executions.length >= 32) return { executions, truncated: true };
	const otherBytes = executions.reduce(
		(sum, entry) => sum + (entry.executionId === output.executionId ? 0 : new TextEncoder().encode(entry.stdout + entry.stderr).length),
		0,
	);
	const stdout = truncateOutput(output.stdout, Math.min(60_000, 120_000 - otherBytes));
	const stderr = truncateOutput(output.stderr, Math.min(60_000, 120_000 - otherBytes - new TextEncoder().encode(stdout).length));
	const entry = { ...output, stdout, stderr, truncated: output.truncated || stdout !== output.stdout || stderr !== output.stderr };
	const next = [...executions];
	if (index === -1) next.push(entry);
	else next[index] = entry;
	return { executions: next, truncated: Boolean(previous?.truncated) || entry.truncated };
}
