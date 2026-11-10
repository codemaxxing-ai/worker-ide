import { expect, it, vi } from 'vitest';

import { ToolOutputBatcher } from './tool-output-batcher';

import type { ToolOutputEvent } from '@shared/agent-state';

it('bounds retained output and coalesces execution snapshots', async () => {
	vi.useFakeTimers();
	try {
		const sent: ToolOutputEvent[][] = [];
		const batcher = new ToolOutputBatcher(
			async (events) => {
				sent.push(events);
			},
			() => {},
		);
		for (let index = 0; index < 100; index++) {
			await batcher.enqueue([
				{
					type: 'tool-output',
					submissionId: 'turn',
					toolCallId: 'outer',
					toolName: 'codemode',
					output: {
						executionId: String(index),
						stdout: '😀'.repeat(20_000),
						stderr: '',
						stdoutBytes: 80_000,
						stderrBytes: 0,
						truncated: false,
					},
				},
			]);
		}
		expect(sent).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(100);
		await batcher.flush();
		const events = sent.flat().filter((event) => event.type === 'tool-output');
		expect(events).toHaveLength(33);
		expect(events.reduce((total, event) => total + new TextEncoder().encode(event.output.stdout + event.output.stderr).length, 0)).toBe(
			120_000,
		);
		expect(events.at(-1)?.output.truncated).toBe(true);
	} finally {
		vi.useRealTimers();
	}
});

it('retains send failures for later flushes', async () => {
	const batcher = new ToolOutputBatcher(
		async () => {
			throw new Error('Delivery failed');
		},
		() => {},
	);
	await batcher.enqueue([
		{
			type: 'tool-output',
			submissionId: 'turn',
			toolCallId: 'call',
			toolName: 'exec',
			output: { executionId: 'execution', stdout: 'working', stderr: '', stdoutBytes: 7, stderrBytes: 0, truncated: false },
		},
	]);
	await expect(batcher.flush()).rejects.toThrow('Delivery failed');
	await expect(batcher.enqueue([])).rejects.toThrow('Delivery failed');
});
