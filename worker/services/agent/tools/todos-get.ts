import { readTodos } from '../tool-executor';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext, ToolResult } from '../types';

const DESCRIPTION = `Read the current TODO list for this session. Returns an array of TODO items with id, content, status (pending/in_progress/completed), and priority (high/medium/low). Use this tool proactively and frequently to stay aware of the current task list.

Usage:
- At the beginning of conversations to see what's pending.
- Before starting new tasks to prioritize work.
- When the user asks about previous tasks or plans.
- Whenever you are uncertain about what to do next.
- After completing tasks to update your understanding of remaining work.
- After every few messages to ensure you are on track.
- Use todos_update to modify the list.`;

export const definition: ToolDefinition = {
	name: 'todos_get',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {},
	},
};

export async function execute(
	_input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
): Promise<ToolResult> {
	const { projectRoot, sessionId } = context;

	sendEvent('status', { message: 'Reading TODOs...' });
	const todos = await readTodos(projectRoot, sessionId);

	const output = JSON.stringify({ todos });

	return { title: 'todos', metadata: { todos }, output };
}
