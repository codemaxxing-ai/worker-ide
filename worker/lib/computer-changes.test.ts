import { Workspace as Computer } from '@cloudflare/computer';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { ComputerChanges } from './computer-changes';
import { computerStorage } from './computer-storage';
import { ComputerWorkspace } from './computer-workspace';

describe('concurrent change drains', () => {
	it('retains a newer write while an earlier drain reads a large baseline', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (project, state) => {
			await project.writeFileContent('/source.txt', 'x'.repeat(210_000));
			const computer = new Computer({ storage: computerStorage(state.storage) });
			const workspace = new ComputerWorkspace(computer);
			const changes = new ComputerChanges(state.storage, () => workspace);
			await changes.capture('writer', '/source.txt');
			await workspace.writeFile('/source.txt', 'first');
			await changes.finish();
			let started: (() => void) | undefined;
			let release: (() => void) | undefined;
			const ready = new Promise<void>((resolve) => {
				started = resolve;
			});
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const readFile = workspace.readFile.bind(workspace);
			let delayed = false;
			vi.spyOn(workspace, 'readFile').mockImplementation(async (path) => {
				if (!delayed && path.startsWith('/.agent/computer-baselines/')) {
					delayed = true;
					started?.();
					await gate;
				}
				return readFile(path);
			});
			const draining = changes.drain('writer');
			await ready;
			await changes.capture('writer', '/source.txt');
			await workspace.writeFile('/source.txt', 'second');
			await changes.finish();
			release?.();
			expect(await draining).toMatchObject([{ afterContent: 'first' }]);
			expect(await changes.drain('writer')).toMatchObject([{ afterContent: 'second' }]);
			expect(await changes.drain('writer')).toEqual([]);
			await computer.close();
		});
	});
});
