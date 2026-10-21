import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_AI_MODEL } from '@shared/constants';

import { createServerTools } from './index';
import { createMockSendEvent } from './test-helpers';

import type { FileChange, ToolExecutorContext } from '../types';

vi.mock('@worker/lib/durable-object-namespaces', () => ({
	coordinatorNamespace: { getByName: () => ({ triggerUpdate: async () => {} }) },
}));

describe('Computer tools against the project workspace', () => {
	it('reads, lists, searches and writes files without starting a container', async () => {
		const fsStub = env.DurableObjectFilesystem.getByName(crypto.randomUUID());
		await fsStub.writeFileContent('/package.json', '{"name":"demo"}');
		await fsStub.writeFileContent('/src/app.tsx', 'original');
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
			return definition.execute(input, { toolCallId: name, messages: [] });
		};

		expect(await execute('read', { path: '/package.json' })).toMatchObject({ content: '{"name":"demo"}' });
		expect(await execute('ls', { path: '/src' })).toMatchObject({ entries: [expect.objectContaining({ name: 'app.tsx' })] });
		expect(await execute('list', { path: '/src' })).toMatchObject({ entries: [expect.objectContaining({ name: 'app.tsx' })] });
		expect(await execute('find', { path: '/', pattern: '**/*.tsx' })).toMatchObject({ count: 1 });
		expect(await execute('grep', { path: '/src', query: 'original' })).toMatchObject({ count: 1 });
		expect(await execute('write', { path: '/src/app.tsx', content: 'changed' })).toMatchObject({ bytesWritten: 7 });
		expect(await execute('write', { path: '/src/new.ts', content: 'created' })).toMatchObject({ bytesWritten: 7 });
		expect(await fsStub.wsReadFile('/src/app.tsx')).toBe('changed');
		expect(await fsStub.wsReadFile('/src/new.ts')).toBe('created');
		expect(await execute('edit', { path: '/src/new.ts', edits: [{ oldText: 'created', newText: 'edited' }] })).not.toHaveProperty('error');
		expect(await fsStub.wsReadFile('/src/new.ts')).toBe('edited');
		expect(await execute('delete', { path: '/src/new.ts' })).not.toHaveProperty('error');
		expect(await fsStub.wsStat('/src/new.ts')).toBeFalsy();
		expect(await execute('read', { path: '/missing.ts' })).toHaveProperty('error');
		expect(changes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: '/src/app.tsx', beforeContent: 'original', afterContent: 'changed' }),
				expect.objectContaining({ path: '/src/new.ts', action: 'create', afterContent: 'created' }),
			]),
		);
		expect(await fsStub.getComputerExecutions('session')).toEqual([]);
	});
});
