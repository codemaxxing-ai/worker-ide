import { describe, expect, it } from 'vitest';

import { ToolFailureGuard, toolOutputError } from './tool-failure-guard';

import type { ToolFailureState } from './tool-failure-guard';

describe('submission failure guard', () => {
	it('deduplicates observations and survives rehydration with canonical arguments', () => {
		let state: ToolFailureState = { submissionId: 'turn', count: 0, seen: [] };
		const create = () =>
			new ToolFailureGuard(
				() => state,
				(next) => {
					state = next;
				},
			);
		const first = create();
		first.record({ id: 'one', toolName: 'exec', input: { command: 'missing', backend: 'shell' }, error: 'Exit 127' });
		first.record({ id: 'one', toolName: 'exec', input: {}, error: 'wrapper error' });
		const resumed = create();
		resumed.record({ id: 'two', toolName: 'exec', input: { backend: 'shell', command: 'missing' }, error: 'Exit 127' });
		expect(state.count).toBe(2);
		resumed.record({ id: 'three', toolName: 'exec', input: { command: 'missing', backend: 'shell' }, error: 'Exit 127' });
		expect(resumed.controller.signal.aborted).toBe(true);
		expect(() => resumed.assertHealthy()).toThrow('three repeated failures');
	});

	it('resets on successful polling, workspace progress, or changed inputs', () => {
		let state: ToolFailureState = { submissionId: 'turn', count: 0, seen: [] };
		const guard = new ToolFailureGuard(
			() => state,
			(next) => {
				state = next;
			},
		);
		const fail = (id: string, input = 'same') => guard.record({ id, toolName: 'read', input, error: 'missing' });
		fail('one');
		fail('two');
		guard.record({ id: 'poll', toolName: 'read', input: 'same' });
		fail('three');
		fail('four');
		guard.progress();
		fail('five');
		fail('six', 'changed');
		expect(state.count).toBe(1);
		expect(() => guard.assertHealthy()).not.toThrow();
	});

	it('recognizes structured Computer failures without parsing successful text', () => {
		expect(toolOutputError({ exitCode: 1 })).toContain('code 1');
		expect(toolOutputError({ error: 'missing path' })).toBe('missing path');
		expect(toolOutputError({ metadata: { exitCode: 127 } })).toContain('127');
		expect(toolOutputError('Tests failed while inspecting old logs')).toBeUndefined();
	});
});
