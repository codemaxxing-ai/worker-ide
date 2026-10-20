import { describe, expect, it } from 'vitest';

import { ToolExecutionError } from '@shared/tool-errors';

import { createSendEventFunction, createToolErrorEvent, drainEventQueue } from './event-helpers';

import type { StreamEvent } from '@shared/agent-state';

describe('tool event queue', () => {
	it('keeps structured tool errors and unexpected failures visible', () => {
		expect(createToolErrorEvent('call-1', 'lint_check', new ToolExecutionError('FILE_NOT_FOUND', 'Missing file'))).toEqual({
			type: 'tool-error',
			toolCallId: 'call-1',
			toolName: 'lint_check',
			errorCode: 'FILE_NOT_FOUND',
			errorMessage: '[FILE_NOT_FOUND] Missing file',
		});
		expect(createToolErrorEvent('call-2', 'exec', new Error('Runtime unavailable'))).toMatchObject({
			errorCode: 'TOOL_EXECUTION_FAILED',
			errorMessage: 'Runtime unavailable',
		});
	});

	it('keeps receiving tool events through the same sender after repeated drains', () => {
		const queue: StreamEvent[] = [];
		const controller = new AbortController();
		const sendEvent = createSendEventFunction(queue, { current: undefined }, controller.signal);
		expect(drainEventQueue(queue)).toEqual([]);

		sendEvent('tool_result', { toolCallId: 'todos-1', tool_name: 'todos_update', title: 'todos', metadata: { todos: [] } });
		const first = drainEventQueue(queue);
		expect(first).toEqual([
			{ type: 'tool-result', toolCallId: 'todos-1', toolName: 'todos_update', title: 'todos', metadata: { todos: [] } },
		]);
		expect(queue).toEqual([]);
		expect(drainEventQueue(queue)).toEqual([]);

		sendEvent('user_question', { question: 'Which color?', options: 'Red, Blue' });
		sendEvent('file_changed', { path: '/src/app.ts', action: 'edit' });
		const second = drainEventQueue(queue);
		expect(second).toEqual([
			{ type: 'user-question', question: 'Which color?', options: 'Red, Blue' },
			expect.objectContaining({ type: 'file-changed', path: '/src/app.ts', action: 'edit' }),
		]);
		expect(first).toHaveLength(1);
		expect(queue).toEqual([]);

		controller.abort();
		sendEvent('status', { message: 'ignored' });
		expect(drainEventQueue(queue)).toEqual([]);
	});
});
