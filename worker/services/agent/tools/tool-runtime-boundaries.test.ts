import { createWorkspaceStateBackend } from '@cloudflare/shell';
import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_AI_MODEL } from '@shared/constants';
import { WorkspaceClient } from '@worker/lib/workspace-client';

import { createServerTools } from './index';
import { createMockSendEvent } from './test-helpers';

import type { FileChange, ToolExecutorContext } from '../types';

vi.mock('@worker/lib/durable-object-namespaces', () => ({
	coordinatorNamespace: { getByName: () => ({ triggerUpdate: async () => {} }) },
}));

async function setup() {
	const fsStub = env.DurableObjectFilesystem.getByName(crypto.randomUUID());
	await fsStub.writeFileContent('/package.json', '{"name":"demo","dependencies":{}}');
	await fsStub.writeFileContent('/src/app.ts', 'original');
	const context: ToolExecutorContext = {
		projectRoot: '/project',
		projectId: 'demo',
		sessionId: 'session',
		mode: 'code',
		model: DEFAULT_AI_MODEL,
		fsStub,
		callMcpTool: async () => '',
	};
	const sendEvent = createMockSendEvent();
	const changes: FileChange[] = [];
	const tools = await createServerTools(sendEvent, context, changes, 'code');
	const execute = async (name: string, input: Record<string, unknown>) => {
		const definition = tools[name];
		if (!definition?.execute) throw new Error(`Missing tool: ${name}`);
		return definition.execute(input, { toolCallId: crypto.randomUUID(), messages: [] });
	};
	return { fsStub, sendEvent, context, changes, execute };
}

describe('tool runtime mutation boundaries', () => {
	it('publishes each revision when a file is written repeatedly', async () => {
		const { sendEvent, execute, fsStub, changes } = await setup();
		await execute('write', { path: '/src/app.ts', content: 'first' });
		await execute('write', { path: '/src/app.ts', content: 'second' });
		expect(await fsStub.wsReadFile('/src/app.ts')).toBe('second');
		const events = sendEvent.calls.filter(([name, value]) => name === 'file_changed' && value.path === '/src/app.ts');
		expect(events.map(([, value]) => value.afterContent)).toEqual(['first', 'second']);
		expect(changes.at(-1)?.afterContent).toBe('second');
	});

	it('preserves concurrent configuration updates from different sessions and tool surfaces', async () => {
		const { fsStub, execute } = await setup();
		await fsStub.registerComputerSession('other-session', 'code');
		await Promise.all([
			execute('dependencies_update', { action: 'add', name: 'is-number', version: '7.0.0' }),
			fsStub.updateManagedConfiguration('dependencies_update', { action: 'add', name: 'is-odd', version: '3.0.1' }, 'other-session'),
			fsStub.updateManagedConfiguration('bindings_update', { storage: 'true' }, 'other-session'),
		]);
		const packageJson = await fsStub.wsReadFile('/package.json');
		expect(packageJson).toContain('is-number');
		expect(packageJson).toContain('is-odd');
		expect(await fsStub.wsReadFile('/wrangler.jsonc')).toContain('STORAGE');
		expect(await fsStub.getComputerExecutions('session')).toEqual([]);
	});

	it('protects configuration through direct tools, state helpers and symlink aliases', async () => {
		const { fsStub, execute } = await setup();
		await fsStub.wsSymlink('/package.json', '/alias');
		await fsStub.wsSymlink('/', '/root-link');
		const state = createWorkspaceStateBackend(new WorkspaceClient(fsStub, '/project', 'session'));
		for (const path of ['/package.json', '/workspace/package.json', '/project/package.json', '/alias', '/root-link/package.json']) {
			await expect(execute('write', { path, content: '{}' })).rejects.toThrow('managed by the IDE');
			await expect(state.writeFile(path, '{}')).rejects.toThrow('managed by the IDE');
		}
		await expect(execute('edit', { path: '/package.json', edits: [{ oldText: 'demo', newText: 'broken' }] })).rejects.toThrow(
			'managed by the IDE',
		);
		await expect(execute('delete', { path: '/', recursive: true })).rejects.toThrow('managed by the IDE');
		await expect(
			(async () => {
				await fsStub.wsMv('/src/app.ts', '/package.json', 'session');
			})(),
		).rejects.toThrow('managed by the IDE');
		await expect(
			(async () => {
				await fsStub.wsCp('/src/app.ts', '/alias', false, 'session');
			})(),
		).rejects.toThrow('managed by the IDE');
		await expect(
			(async () => {
				await fsStub.wsSymlink('/src/app.ts', '/package.json', 'session');
			})(),
		).rejects.toThrow('managed by the IDE');
		await expect(
			(async () => {
				await fsStub.wsAppendFile('/alias', 'bad', 'session');
			})(),
		).rejects.toThrow('managed by the IDE');
		await execute('delete', { path: '/alias' });
		expect(await fsStub.wsReadFile('/package.json')).toContain('demo');
		await execute('dependencies_update', { action: 'add', name: 'is-number', version: '7.0.0' });
		expect(await fsStub.wsReadFile('/package.json')).toContain('is-number');
	});

	it('blocks managed mutations in Ask and Plan modes', async () => {
		const { fsStub } = await setup();
		for (const mode of ['ask', 'plan']) {
			if (mode !== 'ask' && mode !== 'plan') continue;
			await fsStub.registerComputerSession(mode, mode);
			await expect(
				(async () => {
					await fsStub.updateManagedConfiguration('dependencies_update', { action: 'add', name: 'blocked' }, mode);
				})(),
			).rejects.toThrow('cannot mutate');
		}
	});

	it('protects and reviews the target when a managed file itself is a symlink', async () => {
		const { fsStub, execute } = await setup();
		await fsStub.wsMkdir('/config', true);
		await fsStub.wsMv('/package.json', '/config/manifest.json');
		await fsStub.wsSymlink('/config/manifest.json', '/package.json');
		await expect(execute('write', { path: '/config/manifest.json', content: '{}' })).rejects.toThrow('managed by the IDE');
		await execute('dependencies_update', { action: 'add', name: 'is-number', version: '7.0.0' });
		expect(await fsStub.wsReadFile('/config/manifest.json')).toContain('is-number');
	});
});
