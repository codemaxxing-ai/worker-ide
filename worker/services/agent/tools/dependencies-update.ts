import { stripIndent } from 'common-tags';
import { z } from 'zod';

import { coordinatorNamespace } from '@worker/lib/durable-object-namespaces';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext, ToolResult } from '../types';

export const definition: ToolDefinition = {
	name: 'dependencies_update',
	description: stripIndent`
		Add, remove, or update a project dependency. Dependencies are stored in package.json.
		Use this tool instead of npm install, bun add, or editing the protected package.json. The IDE resolves packages for Worker previews and installs them for container previews and builds.
		CRITICAL INSTRUCTION: You MUST register a dependency before importing it in code. Call dependencies_list before adding packages. Do not routinely run bun install after registration; Worker previews/builds resolve registered packages without it. Install only if a required native validation command needs missing container packages.
	`,
	input_schema: {
		type: 'object',
		properties: {
			action: {
				type: 'string',
				description: 'The action to perform: "add", "remove", or "update"',
				enum: ['add', 'remove', 'update'],
			},
			name: {
				type: 'string',
				description: 'The npm package name (e.g. "hono", "@scope/pkg")',
			},
			version: {
				type: 'string',
				description: 'The version specifier (e.g. "^4.0.0", "*"). Defaults to "*" when adding.',
			},
		},
		required: ['action', 'name'],
	},
};

export async function execute(
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
): Promise<ToolResult> {
	sendEvent('status', { message: `Updating dependency: ${input.name}...` });
	using result = await context.fsStub.updateManagedConfiguration('dependencies_update', input, context.sessionId);
	if (result.title !== 'no changes') {
		await coordinatorNamespace
			.getByName(`project:${context.projectId}`)
			.triggerUpdate({ type: 'full-reload', path: '/package.json', timestamp: Date.now(), targets: [] });
	}
	return { title: result.title, metadata: z.record(z.string(), z.unknown()).parse(JSON.parse(result.metadataJson)), output: result.output };
}
