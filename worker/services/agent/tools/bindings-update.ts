import { stripIndent } from 'common-tags';
import { z } from 'zod';

import { coordinatorNamespace } from '@worker/lib/durable-object-namespaces';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext, ToolResult } from '../types';

export const definition: ToolDefinition = {
	name: 'bindings_update',
	description: stripIndent`
		Enable or disable bindings for the project.
		When enabled, the IDE auto-generates type declarations in worker-env.d.ts and injects the binding into the preview worker env.
	`,
	input_schema: {
		type: 'object',
		properties: {
			storage: {
				type: 'string',
				description: 'Enable or disable object storage binding: "true" or "false"',
			},
		},
	},
};

export async function execute(
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
): Promise<ToolResult> {
	sendEvent('status', { message: `Updating bindings config...` });
	using result = await context.fsStub.updateManagedConfiguration('bindings_update', input, context.sessionId);
	if (result.title !== 'no changes') {
		await coordinatorNamespace
			.getByName(`project:${context.projectId}`)
			.triggerUpdate({ type: 'full-reload', path: '/wrangler.jsonc', timestamp: Date.now(), targets: [] });
	}
	return { title: result.title, metadata: z.record(z.string(), z.unknown()).parse(JSON.parse(result.metadataJson)), output: result.output };
}
