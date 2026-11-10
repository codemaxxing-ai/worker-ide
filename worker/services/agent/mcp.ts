import { ToolSetConnector } from '@cloudflare/codemode/ai';
import { z } from 'zod';

import { MCP_SERVERS } from '@shared/constants';

import type { ToolExecutorContext } from './types';
import type { CodemodeConnector } from '@cloudflare/codemode';
import type { ToolSet } from 'ai';

/** Chats share the project directory's catalog and connections through public RPCs. */
export async function createConfiguredMcpConnectors(context: ToolExecutorContext): Promise<CodemodeConnector[]> {
	if (!context.ctx || !context.listMcpTools) return [];
	const descriptors = await context.listMcpTools();
	return MCP_SERVERS.flatMap((server) => {
		const tools: ToolSet = {};
		for (const descriptor of descriptors.filter((tool) => tool.serverId === server.id)) {
			tools[descriptor.name] = {
				description: descriptor.description,
				inputSchema: z.fromJSONSchema(descriptor.inputSchema),
				execute: async (input) => context.callMcpTool(server.id, descriptor.name, z.record(z.string(), z.unknown()).parse(input)),
			};
		}
		if (Object.keys(tools).length === 0 || !context.ctx) return [];
		return [new ToolSetConnector(context.ctx, { name: server.connectorName, instructions: server.instructions, tools })];
	});
}
