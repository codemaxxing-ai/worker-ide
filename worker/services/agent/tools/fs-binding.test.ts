/**
 * Regression: a wrapped tool must have the project filesystem (`fs` proxy)
 * bound when it runs — including when a `tools.*` call is dispatched from the
 * Code Mode sandbox via an inbound Workers RPC into the codemode runtime facet,
 * a fresh I/O context that does NOT inherit the agent loop's
 * `runWithProjectStub` AsyncLocalStorage store.
 *
 * Before the fix, `dependencies_list` (and other `fs`-proxy tools) silently
 * returned "No dependencies registered." in Code Mode because `readDependencies`
 * caught the unbound-fs error. `wrapTool` now re-binds the fs from
 * `context.fsStub` for every execution, so this test runs the tool OUTSIDE any
 * ambient project-fs scope and expects the real dependencies back.
 *
 * This test uses the REAL `@worker/lib/project-fs` (no mock) so the re-binding
 * is actually exercised.
 */
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_AI_MODEL } from '@shared/constants';
import { runWithProjectStub } from '@worker/lib/project-fs';
import { readDependencies } from '@worker/lib/protected-files';

import { createServerTools } from './index';

import type { SendEventFunction, ToolExecutorContext } from '../types';

interface ExecutableTool {
	execute: (input: Record<string, string>, options?: { toolCallId?: string }) => Promise<string>;
}

const PACKAGE_JSON = JSON.stringify({
	name: 'demo',
	dependencies: { 'react-confetti': '6.4.1', react: '^19.0.0' },
});

/** A minimal ProjectFilesystem DO stub backing `readFile` from an in-memory map. */
function createFakeFsStub(files: Record<string, string>): ToolExecutorContext['fsStub'] {
	const stub = {
		// eslint-disable-next-line unicorn/no-null -- the ProjectFilesystem RPC contract returns `null` for a missing file
		wsReadFile: async (path: string): Promise<string | null> => (path in files ? files[path] : null),
		// The no-loader fallback drains after each tool; this fake has no writes.
		drainWorkspaceChanges: async () => Object.assign([], { [Symbol.dispose]: vi.fn() }),
	};
	return stub as unknown as ToolExecutorContext['fsStub'];
}

function createContext(files: Record<string, string>): ToolExecutorContext {
	return {
		projectRoot: '/project',
		projectId: 'demo',
		mode: 'code',
		sessionId: 'session',
		callMcpTool: async () => '',
		fsStub: createFakeFsStub(files),
		model: DEFAULT_AI_MODEL,
	};
}

const noopSendEvent: SendEventFunction = () => {};

describe('wrapTool project-fs binding', () => {
	it('readDependencies returns {} when no fs is bound (the Code Mode hazard)', async () => {
		// No ambient runWithProjectStub scope → the global `fs` proxy is unbound,
		// readDependencies swallows the error. This is the bug the fix addresses.
		expect(await readDependencies('/project')).toEqual({});
	});

	it('a dispatched tool re-binds the fs and reads real dependencies', async () => {
		const context = createContext({ '/package.json': PACKAGE_JSON });
		const tools = await createServerTools(noopSendEvent, context, [], 'code');

		const dependenciesList = tools.dependencies_list as ExecutableTool;
		expect(dependenciesList).toBeDefined();

		// Execute OUTSIDE any runWithProjectStub scope, mirroring a Code Mode
		// sandbox dispatch. The fix re-binds fs from context.fsStub.
		const output = await dependenciesList.execute({});

		expect(output).toContain('react-confetti');
		expect(output).toContain('6.4.1');
	});

	it('control: runWithProjectStub makes readDependencies work directly', async () => {
		const stub = createFakeFsStub({ '/package.json': PACKAGE_JSON });
		const dependencies = await runWithProjectStub(stub, () => readDependencies('/project'), '/project');
		expect(dependencies).toEqual({ 'react-confetti': '6.4.1', react: '^19.0.0' });
	});
});
