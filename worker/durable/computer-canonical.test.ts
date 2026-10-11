import { Workspace as Computer } from '@cloudflare/computer';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { computerStorage } from '../lib/computer-storage';
import { ComputerWorkspace } from '../lib/computer-workspace';

import type { ProjectFilesystem } from './project-filesystem';

describe('Canonical Computer workspaces', () => {
	it('reads an empty project and initializes new files directly without legacy storage', async () => {
		const stub = env.DurableObjectFilesystem.getByName(`canonical-new:${crypto.randomUUID()}`);
		expect(await stub.projectExists()).toBe(false);
		expect(await stub.wsReadDir('/')).toEqual([]);
		expect(await stub.collectProjectSnapshot([])).toEqual({});
		await stub.writeFileContent('/source.txt', 'canonical');
		expect(await stub.wsLstat('/')).toMatchObject({ type: 'directory' });
		expect(await new Response(await stub.computerReadFile('/source.txt')).text()).toBe('canonical');
		await runInDurableObject(stub, (_instance, state) => {
			expect(state.storage.kv.get('project-active-store')).toBe('computer');
			expect(state.storage.kv.get('computer-migration-v1')).toBeUndefined();
			expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'cf_workspace_default'").toArray()).toEqual([]);
		});
	});

	it('keeps the verified Computer tree after eviction and leaves retained recovery data untouched', async () => {
		const name = `canonical-recovery:${crypto.randomUUID()}`;
		const stub = env.DurableObjectFilesystem.getByName(name);
		await stub.writeFileContent('/source.txt', 'canonical edit');
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec('CREATE TABLE cf_workspace_default (path TEXT PRIMARY KEY, content TEXT)');
			state.storage.sql.exec('INSERT INTO cf_workspace_default VALUES (?, ?)', '/source.txt', 'retained legacy bytes');
			state.storage.kv.put('computer-migration-v1', { phase: 'complete', copied: 2 });
			state.storage.kv.put('pending-review', { snapshotId: 'previous' });
		});
		await runInDurableObject(stub, (_instance, state) => {
			state.abort('test canonical reconstruction');
		}).catch(() => {});
		const reconstructed = env.DurableObjectFilesystem.getByName(name);
		expect(await reconstructed.wsReadFile('/source.txt')).toBe('canonical edit');
		expect(await new Response(await reconstructed.computerReadFile('/source.txt')).text()).toBe('canonical edit');
		expect(await reconstructed.computerFind('/', '*.txt')).toContainEqual({ path: '/workspace/source.txt', type: 'file' });
		expect(await reconstructed.computerGrep('canonical', '/')).toContainEqual({
			path: '/workspace/source.txt',
			line: 1,
			text: 'canonical edit',
		});
		await reconstructed.wsWriteFile('/source.txt', 'later edit');
		await runInDurableObject(reconstructed, (_instance, state) => {
			expect(state.storage.sql.exec('SELECT content FROM cf_workspace_default').one().content).toBe('retained legacy bytes');
			expect(state.storage.kv.get('computer-migration-v1')).toEqual({ phase: 'complete', copied: 2 });
			expect(state.storage.kv.get('pending-review')).toEqual({ snapshotId: 'previous' });
		});
	});

	it('blocks cached reads, writes and execution if an initialized project loses its verified marker', async () => {
		const stub = env.DurableObjectFilesystem.getByName(`canonical-marker:${crypto.randomUUID()}`);
		await stub.writeFileContent('/source.txt', 'preserved canonical bytes');
		await stub.wsReadFile('/source.txt');
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.kv.delete('project-active-store');
		});
		await runInDurableObject(stub, async (instance: ProjectFilesystem, state) => {
			await expect(instance.projectExists()).rejects.toThrow('no verified Computer store');
			await expect(instance.wsReadFile('/source.txt')).rejects.toThrow('no verified Computer store');
			await expect(instance.computerReadFile('/source.txt')).rejects.toThrow('no verified Computer store');
			await expect(instance.computerFind('/')).rejects.toThrow('no verified Computer store');
			await expect(instance.computerGrep('preserved', '/')).rejects.toThrow('no verified Computer store');
			await expect(instance.wsWriteFile('/source.txt', 'replacement')).rejects.toThrow('no verified Computer store');
			await expect(instance.computerExec('printf replacement > source.txt', {}, 'guard')).rejects.toThrow('no verified Computer store');
			const retained = new ComputerWorkspace(new Computer({ storage: computerStorage(state.storage) }));
			expect(await retained.readFile('/source.txt')).toBe('preserved canonical bytes');
			expect(state.storage.kv.get('project-active-store')).toBeUndefined();
		});
	});

	it('blocks an unverified legacy tree without creating an empty replacement or changing retained rows', async () => {
		const stub = env.DurableObjectFilesystem.getByName(`canonical-legacy:${crypto.randomUUID()}`);
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec('CREATE TABLE cf_workspace_default (path TEXT PRIMARY KEY, content TEXT)');
			state.storage.sql.exec('INSERT INTO cf_workspace_default VALUES (?, ?)', '/source.txt', 'retained bytes');
		});
		await runInDurableObject(stub, async (instance: ProjectFilesystem, state) => {
			await expect(instance.wsReadFile('/source.txt')).rejects.toThrow('no verified Computer store');
			await expect(instance.projectExists()).rejects.toThrow('no verified Computer store');
			await expect(instance.writeFileContent('/source.txt', 'replacement')).rejects.toThrow('no verified Computer store');
			expect(state.storage.sql.exec('SELECT * FROM cf_workspace_default').toArray()).toEqual([
				{ path: '/source.txt', content: 'retained bytes' },
			]);
			expect(state.storage.kv.get('project-active-store')).toBeUndefined();
			expect(state.storage.kv.get('initialized')).toBeUndefined();
		});
	});

	it('requires recovery for a recorded migration even when initialization and legacy rows are absent', async () => {
		const stub = env.DurableObjectFilesystem.getByName(`canonical-incomplete:${crypto.randomUUID()}`);
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.kv.put('computer-migration-v1', { phase: 'copy', cursor: '/source.txt' });
		});
		await runInDurableObject(stub, async (instance: ProjectFilesystem, state) => {
			await expect(instance.wsReadDir('/')).rejects.toThrow('no verified Computer store');
			await expect(instance.wsMkdir('/fresh', true)).rejects.toThrow('no verified Computer store');
			expect(state.storage.kv.get('project-active-store')).toBeUndefined();
			expect(state.storage.kv.get('computer-migration-v1')).toEqual({ phase: 'copy', cursor: '/source.txt' });
		});
	});

	it('requires recovery for a non-Computer active store', async () => {
		const stub = env.DurableObjectFilesystem.getByName(`canonical-other-store:${crypto.randomUUID()}`);
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.kv.put('project-active-store', 'legacy');
		});
		await runInDurableObject(stub, async (instance: ProjectFilesystem, state) => {
			await expect(instance.wsWriteFile('/source.txt', 'replacement')).rejects.toThrow('no verified Computer store');
			expect(state.storage.kv.get('project-active-store')).toBe('legacy');
		});
	});
});
