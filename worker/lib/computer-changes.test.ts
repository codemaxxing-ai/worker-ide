import { Workspace as Computer } from '@cloudflare/computer';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { ComputerChanges } from './computer-changes';
import { ComputerWorkspace } from './computer-workspace';

describe('concurrent change drains', () => {
	it('retains a newer write while an earlier drain reads a large baseline', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (project, state) => {
			await project.writeFileContent('/source.txt', 'x'.repeat(210_000));
			const computer = new Computer({ storage: state.storage });
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
			const draining = changes.claim('writer', 'test-operation', crypto.randomUUID());
			await ready;
			await changes.capture('writer', '/source.txt');
			await workspace.writeFile('/source.txt', 'second');
			await changes.finish();
			release?.();
			expect(await draining).toMatchObject([{ afterContent: 'first' }]);
			expect(await changes.claim('writer', 'test-operation', crypto.randomUUID())).toMatchObject([{ afterContent: 'second' }]);
			expect(await changes.claim('writer', 'test-operation', crypto.randomUUID())).toEqual([]);
			await computer.close();
		});
	});
});

it('retains frozen change receipts until acknowledgement, including after a lost reply', async () => {
	await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (project, state) => {
		await project.writeFileContent('/source.txt', 'before');
		const computer = new Computer({ storage: state.storage });
		const workspace = new ComputerWorkspace(computer);
		const changes = new ComputerChanges(state.storage, () => workspace);
		await changes.capture('writer', '/source.txt');
		await workspace.writeFile('/source.txt', 'first');
		await changes.finish();
		await changes.claim('writer', 'turn', 'receipt');
		const reopened = new ComputerChanges(state.storage, () => workspace);
		expect(reopened.pending('writer', 'turn')).toEqual(['receipt']);
		await reopened.capture('writer', '/source.txt');
		await workspace.writeFile('/source.txt', 'second');
		await reopened.finish();
		expect(await reopened.claim('writer', 'turn', 'receipt')).toMatchObject([{ beforeContent: 'before', afterContent: 'first' }]);
		await expect(reopened.claim('other', 'turn', 'receipt')).rejects.toThrow('another turn');
		expect(await reopened.claim('writer', 'turn', 'second-receipt')).toMatchObject([{ beforeContent: 'first', afterContent: 'second' }]);
		expect(() => reopened.acknowledge('other', 'receipt')).toThrow('another session');
		reopened.acknowledge('writer', 'receipt');
		expect(reopened.pending('writer', 'turn')).toEqual(['second-receipt']);
		await computer.close();
	});
});
