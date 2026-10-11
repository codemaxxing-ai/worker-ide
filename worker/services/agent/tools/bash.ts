import { ToolErrorCode, toolError } from '@shared/tool-errors';

import { executeComputerCommand } from './computer-tools';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext, ToolResult } from '../types';

const DESCRIPTION = `Compatibility adapter for Computer exec with the shell backend, mounted at /workspace.

Use this for shell-style workflows that combine multiple file operations or text processing in one step — pipelines with cat, grep, sed, awk, jq, sort, uniq, wc, cut, find, ls, tr, head, tail, diff, and friends. For a single read/write/edit, prefer the dedicated state.* operations.

Environment:
- The project root is the working directory (/workspace); paths are resolved relative to it.
- Created, updated, and deleted files persist back to the workspace.
- Network access, Python, and arbitrary JS execution are DISABLED. Only built-in commands and local Git operations are available. Use exec with the container backend for native binaries and package installation.
- Each invocation runs in a fresh shell (env/cwd reset); only filesystem changes persist between calls.`;

export const definition: ToolDefinition = {
	name: 'bash',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {
			command: {
				type: 'string',
				description: 'The bash command line to run, e.g. `grep -rn "TODO" src | wc -l`.',
			},
		},
		required: ['command'],
	},
};

export async function execute(
	input: Record<string, string>,
	_sendEvent: SendEventFunction,
	context: ToolExecutorContext,
): Promise<ToolResult> {
	const command = input.command?.trim();
	if (!command) {
		return toolError(ToolErrorCode.MISSING_INPUT, 'A non-empty command is required.');
	}

	const result = await executeComputerCommand(context, command, { backend: 'shell' });

	return {
		title: command.length > 60 ? `${command.slice(0, 60)}…` : command,
		metadata: { exitCode: result.exitCode, backend: result.backend, status: result.status },
		output: [result.stdout, result.stderr].filter(Boolean).join('\n'),
	};
}
