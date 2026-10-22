import { Workspace as Computer } from '@cloudflare/computer';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { ComputerProtectedFiles } from './computer-protected-files';
import { computerStorage } from './computer-storage';
import { ComputerWorkspace } from './computer-workspace';

describe('durable configuration preservation', () => {
	it('recovers chunked baselines after reconstruction and restores replaced file types', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (project, state) => {
			const original = 'x'.repeat(180_000);
			await project.writeFileContent('/package.json', original);
			const computer = new Computer({ storage: computerStorage(state.storage) });
			const workspace = new ComputerWorkspace(computer);
			await workspace.symlink('/package.json', '/vite.config.ts');
			await new ComputerProtectedFiles(state.storage, workspace).capture('execution');
			await workspace.rm('/package.json');
			await workspace.mkdir('/package.json');
			await workspace.writeFile('/package.json/child', 'unwanted');
			await workspace.rm('/vite.config.ts');
			await workspace.writeFile('/vite.config.ts', 'unwanted replacement');
			await workspace.writeFile('/wrangler.jsonc', 'new protected file');
			const recovered = new ComputerProtectedFiles(state.storage, workspace);
			expect(await recovered.restore('execution')).toEqual(['/package.json', '/wrangler.jsonc', '/vite.config.ts']);
			expect(await workspace.readFile('/package.json')).toBe(original);
			expect(await workspace.readlink('/vite.config.ts')).toBe('/package.json');
			expect(await workspace.exists('/wrangler.jsonc')).toBe(false);
			expect(await recovered.restore('execution')).toEqual([]);
			recovered.clear('execution');
			await computer.close();
		});
	});

	it('restores the bytes behind a protected symlink', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (project, state) => {
			await project.writeFileContent('/config/manifest.json', 'original');
			const computer = new Computer({ storage: computerStorage(state.storage) });
			const workspace = new ComputerWorkspace(computer);
			await workspace.symlink('/config/manifest.json', '/package.json');
			const guard = new ComputerProtectedFiles(state.storage, workspace);
			await guard.capture('execution');
			await workspace.writeFile('/config/manifest.json', 'changed');
			expect(await guard.restore('execution')).toEqual(['/config/manifest.json']);
			expect(await workspace.readFile('/package.json')).toBe('original');
			guard.clear('execution');
			await computer.close();
		});
	});
});
