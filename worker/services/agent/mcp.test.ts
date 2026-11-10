import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { createConfiguredMcpConnectors } from './mcp';
import { createMockContext } from './tools/test-helpers';

describe('shared project MCP catalog', () => {
	it('exposes configured namespaces and calls the project proxy with validated inputs', async () => {
		const project = env.DurableObjectFilesystem.getByName(crypto.randomUUID());
		await runInDurableObject(project, async (_instance, state) => {
			const call = vi.fn(async () => 'Documentation');
			const connectors = await createConfiguredMcpConnectors(
				createMockContext({
					ctx: state,
					callMcpTool: call,
					listMcpTools: async () => [
						{
							serverId: 'cloudflare-docs',
							name: 'search_cloudflare_documentation',
							description: 'Search docs',
							inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
						},
					],
				}),
			);
			const connector = connectors[0];
			if (!connector) throw new Error('Missing connector');
			expect(connector.name()).toBe('cloudflare_docs');
			expect(await connector.executeTool('search_cloudflare_documentation', { query: 'Durable Objects' }, { executionId: 'search' })).toBe(
				'Documentation',
			);
			expect(call).toHaveBeenCalledWith('cloudflare-docs', 'search_cloudflare_documentation', { query: 'Durable Objects' });
			await expect(connector.executeTool('search_cloudflare_documentation', { query: 42 }, { executionId: 'invalid' })).rejects.toThrow();
			expect(call).toHaveBeenCalledOnce();
		});
	});
	it('does not expose servers outside the configured catalog', async () => {
		const project = env.DurableObjectFilesystem.getByName(crypto.randomUUID());
		await runInDurableObject(project, async (_instance, state) => {
			const connectors = await createConfiguredMcpConnectors(
				createMockContext({
					ctx: state,
					listMcpTools: async () => [{ serverId: 'unconfigured', name: 'danger', inputSchema: { type: 'object' } }],
				}),
			);
			expect(connectors).toEqual([]);
		});
	});
});
