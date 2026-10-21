import { describe, expect, it } from 'vitest';

import { buildSubAgentParentEvents } from './sub-agent-worker';

import type { StreamEvent } from '@shared/agent-state';

describe('sub-agent parent events', () => {
	it('forwards file changes and associates rich tool metadata with the parent tool call', () => {
		const events: StreamEvent[] = [
			{ type: 'status', message: 'working' },
			{ type: 'file-changed', path: 'src/app.ts', action: 'edit', beforeContent: 'old' },
			{
				type: 'tool-result',
				toolCallId: 'child-call',
				toolName: 'read_file',
				title: 'Read src/app.ts',
				metadata: { path: 'src/app.ts' },
			},
		];

		expect(buildSubAgentParentEvents(events, 'parent-call')).toEqual([
			events[1],
			{
				type: 'sub-agent-activity',
				parentToolCallId: 'parent-call',
				activity: {
					kind: 'tool-metadata',
					toolName: 'read_file',
					title: 'Read src/app.ts',
					metadata: { path: 'src/app.ts' },
				},
			},
		]);
	});

	it('forwards tool failures so child calls cannot appear successful', () => {
		expect(
			buildSubAgentParentEvents(
				[
					{
						type: 'tool-error',
						toolCallId: 'child-call',
						toolName: 'write',
						errorCode: 'NOT_ALLOWED',
						errorMessage: 'Protected file',
					},
				],
				'parent-call',
			),
		).toEqual([
			{
				type: 'sub-agent-activity',
				parentToolCallId: 'parent-call',
				activity: {
					kind: 'tool-metadata',
					toolName: 'write',
					title: 'Error',
					metadata: { error: 'Protected file', errorCode: 'NOT_ALLOWED' },
				},
			},
		]);
	});
});
