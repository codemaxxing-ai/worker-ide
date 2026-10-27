import { ToolSetConnector } from '@cloudflare/codemode/ai';
import { asSchema } from 'ai';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_AI_MODEL } from '@shared/constants';

import { createServerTools } from './index';
import { createMockSendEvent } from './test-helpers';

vi.mock('@worker/lib/durable-object-namespaces', () => ({
	coordinatorNamespace: { getByName: () => ({ triggerUpdate: async () => {} }) },
}));

describe('direct and CodeMode validation parity', () => {
	it.each([
		{ path: '/source.txt', edits: [{ oldText: 'old', newText: 42 }] },
		{ path: '/source.txt', edits: [{ oldText: 'old' }] },
		{ path: '/source.txt', edits: [{ oldText: 'old', newText: 'new', unknown: true }] },
		{ path: '/source.txt', edits: [], unknown: true },
	])('rejects nested and closed inputs on both surfaces without executor calls: %j', async (input) => {
		const project = env.DurableObjectFilesystem.getByName(crypto.randomUUID());
		const objectId = project.id.toString();
		await runInDurableObject(project, async (_project, state) => {
			const fsStub = env.DurableObjectFilesystem.get(env.DurableObjectFilesystem.idFromString(objectId));
			const tools = await createServerTools(
				createMockSendEvent(),
				{
					projectRoot: '/project',
					projectId: 'test',
					sessionId: 'session',
					mode: 'code',
					model: DEFAULT_AI_MODEL,
					fsStub,
					callMcpTool: async () => '',
				},
				[],
				'code',
			);
			const edit = tools.edit;
			if (!edit) throw new Error('Missing edit tool');
			const execute = vi.fn(async () => 'must not execute');
			const direct = await asSchema(edit.inputSchema).validate?.(input);
			expect(direct?.success).toBe(false);
			if (direct?.success) await execute();
			const connector = new ToolSetConnector(state, { tools: { edit: { ...edit, execute } } });
			await expect(connector.executeTool('edit', input, { executionId: 'test', seq: 0 })).rejects.toThrow('Invalid input');
			expect(execute).not.toHaveBeenCalled();
		});
	});
});
