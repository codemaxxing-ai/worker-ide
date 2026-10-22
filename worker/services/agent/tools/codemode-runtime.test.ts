import { DynamicWorkerExecutor } from '@cloudflare/codemode';
import { ToolSetConnector } from '@cloudflare/codemode/ai';
import { createWorkspaceStateBackend } from '@cloudflare/shell';
import { StateConnector } from '@cloudflare/shell/workers';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_AI_MODEL } from '@shared/constants';
import { WorkspaceClient } from '@worker/lib/workspace-client';

import { createServerTools } from './index';
import { createMockSendEvent } from './test-helpers';

vi.mock('@worker/lib/durable-object-namespaces', () => ({
	coordinatorNamespace: { getByName: () => ({ triggerUpdate: async () => {} }) },
}));

describe('Code Mode Worker filesystem access', () => {
	it('uses the same workspace for native tools and state helpers across RPC', async () => {
		const project = env.DurableObjectFilesystem.getByName(crypto.randomUUID());
		await project.writeFileContent('/src/app.ts', 'original');
		await project.writeFileContent('/package.json', '{"name":"demo","dependencies":{}}');
		const objectId = project.id.toString();
		const result = await runInDurableObject(project, async (_instance, state) => {
			const fsStub = env.DurableObjectFilesystem.get(env.DurableObjectFilesystem.idFromString(objectId));
			const tools = await createServerTools(
				createMockSendEvent(),
				{
					projectRoot: '/project',
					projectId: 'demo',
					sessionId: 'session',
					mode: 'code',
					model: DEFAULT_AI_MODEL,
					fsStub,
					callMcpTool: async () => '',
				},
				[],
				'code',
			);
			const connectors = [
				new ToolSetConnector(state, { tools }),
				new StateConnector(state, createWorkspaceStateBackend(new WorkspaceClient(fsStub, '/project', 'session'))),
			];
			const providers = await Promise.all(
				connectors.map(async (connector) => ({
					name: connector.name(),
					fns: Object.fromEntries(
						Object.keys(await connector.tools()).map((name) => [
							name,
							(input: unknown) => connector.executeTool(name, input, { executionId: 'test', seq: 0 }),
						]),
					),
				})),
			);
			// The test workerd lacks durable facets; exercise the real isolated Worker
			// and SDK connectors directly, without mocking the filesystem RPC boundary.
			const loader: WorkerLoader = {
				get: (name, getCode) => env.LOADER.get(name, getCode),
				// The test workerd predates load(); get() creates the same isolated Worker.
				load: (code) => env.LOADER.get(crypto.randomUUID(), () => code),
			};
			// eslint-disable-next-line unicorn/no-null -- Disable sandbox network access.
			const executor = new DynamicWorkerExecutor({ loader, globalOutbound: null });
			return executor.execute(
				`
				const before = await tools.read({path:"/src/app.ts"});
				await state.writeFile({path:"/src/new.ts",content:"from Code Mode"});
				let protectedError;
				try { await state.writeFile({path:"/package.json",content:"{}"}); } catch (error) { protectedError = String(error); }
				await tools.dependencies_update({action:"add",name:"is-number",version:"7.0.0"});
				return {before, protectedError, after:await tools.read({path:"/src/new.ts"})};
			`,
				providers,
			);
		});
		expect(JSON.stringify(result)).toContain('original');
		expect(JSON.stringify(result)).toContain('managed by the IDE');
		expect(await project.wsReadFile('/src/new.ts')).toBe('from Code Mode');
		expect(await project.wsReadFile('/package.json')).toContain('is-number');
	});
});
