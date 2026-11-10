import { asSchema } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import { ToolFailureGuard } from '../tool-failure-guard';
import { createAgentToolCatalog, createServerTools, SUB_AGENT_EXCLUDED_TOOLS } from './index';
import { createMockContext, createMockSendEvent } from './test-helpers';

import type { ToolFailureState } from '../tool-failure-guard';

function context(overrides?: Parameters<typeof createMockContext>[0]) {
	const value = createMockContext(overrides);
	Reflect.set(value.fsStub, 'claimAgentChanges', async () => Object.assign([], { [Symbol.dispose]: () => {} }));
	Reflect.set(value.fsStub, 'wsReadFile', async () => '[]');
	return value;
}

describe('one guarded tool catalog', () => {
	it('shares Computer and dependency tools between direct and programmatic calls without legacy aliases', async () => {
		const catalog = await createAgentToolCatalog(createMockSendEvent(), context(), [], 'code');
		for (const name of ['read', 'ls', 'find', 'grep', 'write', 'edit', 'delete', 'exec', 'dependencies_list', 'dependencies_update']) {
			expect(catalog.directTools[name]?.execute).toBeTypeOf('function');
			expect(catalog.nestedTools[name]?.execute).toBeTypeOf('function');
		}
		expect(catalog.directTools).not.toHaveProperty('list');
		expect(catalog.nestedTools).not.toHaveProperty('bash');
		expect(catalog.nestedTools).not.toHaveProperty('user_question');
	});
	it.each(['plan', 'ask'])('removes source mutations and commands from both %s surfaces', async (mode) => {
		if (mode !== 'plan' && mode !== 'ask') throw new Error('Invalid mode');
		const catalog = await createAgentToolCatalog(createMockSendEvent(), context({ mode }), [], mode);
		for (const surface of [catalog.directTools, catalog.nestedTools]) {
			for (const name of ['write', 'edit', 'delete', 'exec', 'dependencies_update', 'browser']) expect(surface).not.toHaveProperty(name);
			for (const name of ['read', 'ls', 'find', 'grep', 'dependencies_list']) expect(surface).toHaveProperty(name);
		}
	});
	it('does not expose recursive delegation or interactive tools to delegated tasks', async () => {
		const catalog = await createAgentToolCatalog(
			createMockSendEvent(),
			context({ isSubAgent: true }),
			[],
			'code',
			undefined,
			SUB_AGENT_EXCLUDED_TOOLS,
		);
		for (const name of SUB_AGENT_EXCLUDED_TOOLS) {
			expect(catalog.directTools).not.toHaveProperty(name);
			expect(catalog.nestedTools).not.toHaveProperty(name);
		}
	});
	it('aborts before a direct tool emits an event or performs a side effect', async () => {
		const events = createMockSendEvent();
		const catalog = await createAgentToolCatalog(events, context(), [], 'code');
		const question = catalog.directTools.user_question;
		if (!question?.execute) throw new Error('Missing question tool');
		const abort = new AbortController();
		abort.abort();
		await expect(
			question.execute({ question: 'Choose?' }, { toolCallId: 'question', messages: [], abortSignal: abort.signal }),
		).rejects.toThrow();
		expect(events.calls).toEqual([]);
	});
	it('records durable mutation intent before crossing the workspace boundary', async () => {
		const beforeMutation = vi.fn();
		const execution = vi.fn(async () => ({ bytesWritten: 1 }));
		const toolContext = context({ beforeMutation });
		Reflect.set(toolContext.fsStub, 'computerApplyTool', execution);
		const catalog = await createAgentToolCatalog(createMockSendEvent(), toolContext, [], 'code');
		const write = catalog.nestedTools.write;
		if (!write?.execute) throw new Error('Missing write tool');
		await write.execute({ path: '/source.ts', content: 'x' }, { toolCallId: 'write', messages: [] });
		expect(beforeMutation.mock.invocationCallOrder[0]).toBeLessThan(execution.mock.invocationCallOrder[0]);
	});
	it('rejects unknown arguments before executing a workspace tool', async () => {
		const catalog = await createAgentToolCatalog(createMockSendEvent(), context(), [], 'code');
		const write = catalog.directTools.write;
		if (!write) throw new Error('Missing write tool');
		const schema = asSchema(write.inputSchema);
		const result = await schema.validate?.({ path: '/source.ts', content: 'x', invented: true });
		expect(result?.success).toBe(false);
	});
	it('blocks further mutations after three failed nested commands, even when their caller catches errors', async () => {
		let state: ToolFailureState = { submissionId: 'run', count: 0, seen: [] };
		const guard = new ToolFailureGuard(
			() => state,
			(next) => {
				state = next;
			},
		);
		const toolContext = context({ failureGuard: guard });
		Reflect.set(toolContext.fsStub, 'computerExec', async () => ({
			backend: 'shell',
			exitCode: 7,
			stdout: '',
			stderr: '',
			[Symbol.dispose]: () => {},
		}));
		const catalog = await createAgentToolCatalog(createMockSendEvent(), toolContext, [], 'code');
		const execute = catalog.nestedTools.exec;
		const write = catalog.nestedTools.write;
		if (!execute?.execute || !write?.execute) throw new Error('Missing tools');
		for (let index = 0; index < 3; index++)
			await execute.execute({ command: 'exit 7', backend: 'shell' }, { toolCallId: `call-${index}`, messages: [] });
		await expect(write.execute({ path: '/source.ts', content: 'must not run' }, { toolCallId: 'blocked', messages: [] })).rejects.toThrow(
			'three repeated failures',
		);
	});
	it('fails explicitly when the production sandbox bindings are missing', async () => {
		await expect(createServerTools(createMockSendEvent(), context(), [], 'code')).rejects.toThrow('requires');
	});
});
