import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_AI_MODEL } from '@shared/constants/ai-models';
import { fs, runWithProjectStub } from '@worker/lib/project-fs';
import { PROJECT_ROOT } from '@worker/lib/workspace-client';

import { drainWorkspaceChanges } from './drain-workspace-changes';

import type { ProjectFilesystem } from '../../../durable/project-filesystem';
import type { FileChange, ToolExecutorContext } from '../types';

function getFilesystemStub(name: string): DurableObjectStub<ProjectFilesystem> {
	const namespace = env.DurableObjectFilesystem as DurableObjectNamespace<ProjectFilesystem>;
	return namespace.getByName(name);
}

function buildContext(fsStub: DurableObjectStub<ProjectFilesystem>, sessionId: string): ToolExecutorContext {
	return {
		projectRoot: PROJECT_ROOT,
		projectId: 'test-project',
		mode: 'code',
		sessionId,
		fsStub,
		model: DEFAULT_AI_MODEL,
		callMcpTool: async () => '',
	};
}

describe('drainWorkspaceChanges', () => {
	it('includes Git-adjacent files in review changes and HMR notifications', async () => {
		const stub = getFilesystemStub('test-drain-git-adjacent-review');
		const context = buildContext(stub, 'session-git-adjacent');
		const queryChanges: FileChange[] = [];
		const sendEvent = vi.fn();
		const triggerHmr = vi.fn(async () => {});
		await stub.wsWriteFile('/.gitignore', 'dist\n', context.sessionId);
		await stub.wsWriteFile('/.github/workflows/ci.yml', 'name: CI\n', context.sessionId);

		await drainWorkspaceChanges(context, sendEvent, queryChanges, new Set(), triggerHmr);

		expect(queryChanges.map((change) => change.path).toSorted()).toEqual(['/.github/workflows/ci.yml', '/.gitignore']);
		expect(sendEvent).toHaveBeenCalledTimes(2);
		expect(triggerHmr).toHaveBeenCalledWith('test-project', expect.arrayContaining(['/.gitignore', '/.github/workflows/ci.yml']));
	});

	it('records a change in queryChanges even when the path was already emitted by a tools.* call', async () => {
		const stub = getFilesystemStub('test-drain-already-emitted');
		const sessionId = 'session-emitted';
		// A `tools.*` call earlier this turn already announced /x to the UI.
		const emittedChangePaths = new Set(['/x.ts']);
		const context = buildContext(stub, sessionId);
		const queryChanges: FileChange[] = [];
		const sendEvent = vi.fn();
		const triggerHmr = vi.fn(async () => {});

		// A later state.writeFile mutates the same path.
		await stub.wsWriteFile('/x.ts', 'export const x = 2;\n', sessionId);

		await drainWorkspaceChanges(context, sendEvent, queryChanges, emittedChangePaths, triggerHmr);

		// The change is NOT dropped — the review queue must reflect the final content.
		expect(queryChanges).toEqual([
			{ path: '/x.ts', action: 'create', beforeContent: undefined, afterContent: 'export const x = 2;\n', isBinary: false },
		]);
		// But the duplicate UI event is suppressed.
		expect(sendEvent).not.toHaveBeenCalled();
		// HMR is still triggered for the path.
		expect(triggerHmr).toHaveBeenCalledWith('test-project', ['/x.ts']);
	});

	it('emits a file_changed event for a path not already emitted', async () => {
		const stub = getFilesystemStub('test-drain-fresh-emit');
		const sessionId = 'session-fresh';
		const emittedChangePaths = new Set<string>();
		const context = buildContext(stub, sessionId);
		const queryChanges: FileChange[] = [];
		const sendEvent = vi.fn();
		const triggerHmr = vi.fn(async () => {});

		await stub.wsWriteFile('/y.ts', 'export const y = 1;\n', sessionId);

		await drainWorkspaceChanges(context, sendEvent, queryChanges, emittedChangePaths, triggerHmr);

		expect(sendEvent).toHaveBeenCalledWith('file_changed', {
			path: '/y.ts',
			action: 'create',
			beforeContent: undefined,
			afterContent: 'export const y = 1;\n',
		});
		expect(queryChanges).toHaveLength(1);
	});

	it('surfaces a fs-proxy edit as a proper before/after diff, not a whole-file create', async () => {
		const stub = getFilesystemStub('test-drain-deps-update');
		const sessionId = 'session-deps';
		const context = buildContext(stub, sessionId);
		const queryChanges: FileChange[] = [];
		const sendEvent = vi.fn();
		const triggerHmr = vi.fn(async () => {});

		// Seed an existing package.json — this is the pre-edit baseline. The direct
		// write is unattributed (no writerId), like the initial project scaffold.
		await stub.writeFileContent('/package.json', '{"dependencies":{}}\n');

		// Simulate a dependencies_update-style write through the `fs` proxy, bound
		// with the session as writerId exactly as `wrapTool` re-binds it. The DO
		// must capture the seeded content as the baseline BEFORE this write.
		await runWithProjectStub(
			stub,
			async () => {
				await fs.writeFile(`${PROJECT_ROOT}/package.json`, '{"dependencies":{"react-confetti":"^6.4.0"}}\n');
			},
			PROJECT_ROOT,
			sessionId,
		);

		await drainWorkspaceChanges(context, sendEvent, queryChanges, new Set<string>(), triggerHmr);

		// The diff is an edit with the real baseline — NOT a create with the whole
		// file as "added" (the bug when the baseline was never attributed).
		expect(queryChanges).toEqual([
			{
				path: '/package.json',
				action: 'edit',
				beforeContent: '{"dependencies":{}}\n',
				afterContent: '{"dependencies":{"react-confetti":"^6.4.0"}}\n',
				isBinary: false,
			},
		]);
	});

	it('skips re-recording a path the tool already pushed (fallback dedupe), but still emits and HMRs', async () => {
		const stub = getFilesystemStub('test-drain-already-recorded');
		const sessionId = 'session-recorded';
		const context = buildContext(stub, sessionId);
		// The fallback tool already pushed /z.ts into queryChanges this turn.
		const queryChanges: FileChange[] = [{ path: '/z.ts', action: 'edit', beforeContent: 'a\n', afterContent: 'b\n', isBinary: false }];
		const sendEvent = vi.fn();
		const triggerHmr = vi.fn(async () => {});

		await stub.wsWriteFile('/z.ts', 'export const z = 1;\n', sessionId);

		await drainWorkspaceChanges(context, sendEvent, queryChanges, new Set<string>(), triggerHmr, new Set(['/z.ts']));

		// No duplicate record — only the tool's original entry remains.
		expect(queryChanges).toHaveLength(1);
		// The UI event still fires (not in emittedChangePaths) and HMR is triggered.
		expect(sendEvent).toHaveBeenCalledWith('file_changed', expect.objectContaining({ path: '/z.ts' }));
		expect(triggerHmr).toHaveBeenCalledWith('test-project', ['/z.ts']);
	});

	it('does not trigger HMR when there are no changes to drain', async () => {
		const stub = getFilesystemStub('test-drain-empty');
		const context = buildContext(stub, 'session-empty');
		const queryChanges: FileChange[] = [];
		const sendEvent = vi.fn();
		const triggerHmr = vi.fn(async () => {});

		await drainWorkspaceChanges(context, sendEvent, queryChanges, new Set<string>(), triggerHmr);

		expect(queryChanges).toEqual([]);
		expect(sendEvent).not.toHaveBeenCalled();
		expect(triggerHmr).not.toHaveBeenCalled();
	});
});
