import { describe, expect, it } from 'vitest';

import { mergeCommandOutput, truncateOutput } from './command-output';

describe('command output snapshots', () => {
	it('truncates only at UTF-8 boundaries', () => {
		expect(truncateOutput('a😀b', 4)).toBe('a');
		expect(truncateOutput('a😀b', 5)).toBe('a😀');
		expect(truncateOutput('😀', 0)).toBe('');
	});
	it('deduplicates full replay and rejects older or post-final snapshots', () => {
		const output = { executionId: 'one', stdout: 'hello', stderr: '', stdoutBytes: 5, stderrBytes: 0, truncated: false };
		const state = mergeCommandOutput(undefined, output);
		expect(mergeCommandOutput(state, output)).toEqual(state);
		expect(mergeCommandOutput(state, { ...output, stdout: 'hel', stdoutBytes: 3 })).toEqual(state);
		const final = mergeCommandOutput(state, { ...output, final: true });
		expect(mergeCommandOutput(final, { ...output, stdout: 'late', stdoutBytes: 9 })).toEqual(final);
	});
	it('bounds aggregate bytes and execution records', () => {
		let state = mergeCommandOutput(undefined, {
			executionId: 'one',
			stdout: 'x'.repeat(70_000),
			stderr: 'y'.repeat(70_000),
			stdoutBytes: 70_000,
			stderrBytes: 70_000,
			truncated: false,
		});
		for (let index = 0; index < 40; index++)
			state = mergeCommandOutput(state, {
				executionId: String(index),
				stdout: 'extra',
				stderr: '',
				stdoutBytes: 5,
				stderrBytes: 0,
				truncated: false,
			});
		expect(state.executions).toHaveLength(32);
		expect(state.executions.reduce((total, entry) => total + new TextEncoder().encode(entry.stdout + entry.stderr).length, 0)).toBe(
			120_000,
		);
		expect(state.truncated).toBe(true);
	});
});
