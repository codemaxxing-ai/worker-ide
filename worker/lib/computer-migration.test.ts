import { Workspace as Computer } from '@cloudflare/computer';
import { Workspace } from '@cloudflare/shell';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { ComputerMigration } from './computer-migration';
import { computerStorage } from './computer-storage';
import { ComputerWorkspace } from './computer-workspace';

describe('Computer migration', () => {
	it('never recopies a completed migration after retries or reconstruction', async () => {
		const stub = env.DurableObjectFilesystem.getByName(`migration-once:${crypto.randomUUID()}`);
		await runInDurableObject(stub, async (_instance, state) => {
			const legacy = new Workspace({ sql: state.storage.sql });
			const destination = new ComputerWorkspace(new Computer({ storage: computerStorage(state.storage) }));
			await legacy.writeFile('/source.txt', 'before migration');
			const migration = new ComputerMigration(state.storage, legacy, destination);
			while (!(await migration.batch())) {
				/* Complete the initial conversion. */
			}
			const completedStatus = migration.status();
			await destination.writeFile('/source.txt', 'edited after migration');
			const readLegacy = vi.spyOn(legacy, 'readFileBytes');
			const reconstructed = new ComputerMigration(state.storage, legacy, destination);
			await reconstructed.retry();
			expect(await reconstructed.batch()).toBe(true);
			expect(await reconstructed.batch()).toBe(true);
			expect(reconstructed.status()).toEqual(completedStatus);
			expect(readLegacy).not.toHaveBeenCalled();
			expect(await destination.readFile('/source.txt')).toBe('edited after migration');
			expect(await legacy.readFile('/source.txt')).toBe('before migration');
		});
	});

	it('resumes batches and preserves bytes, R2 content, directories, links, git and snapshots', async () => {
		const stub = env.DurableObjectFilesystem.getByName(`migration:${crypto.randomUUID()}`);
		await runInDurableObject(stub, async (_instance, state) => {
			const legacy = new Workspace({ sql: state.storage.sql, r2: env.STORAGE_BUCKET, r2Prefix: `migration/${state.id}` });
			const destination = new ComputerWorkspace(new Computer({ storage: computerStorage(state.storage) }));
			await legacy.mkdir('/empty', { recursive: true });
			await legacy.writeFile('/.git/HEAD', 'ref: refs/heads/main\n');
			await legacy.writeFile('/.git/objects/history', 'git history');
			await legacy.writeFile('/.agent/snapshots/previous/src.txt', 'before uncommitted edit');
			const bytes = new Uint8Array(1_600_000).fill(255);
			await legacy.writeFileBytes('/blob.bin', bytes);
			await legacy.symlink('/src.txt', '/absolute');
			await legacy.symlink('src.txt', '/relative');
			for (let index = 0; index < 30; index++) await legacy.writeFile(`/text-${index}.txt`, `text ${index}`);
			await legacy.writeFile('/src.txt', 'uncommitted');
			state.storage.kv.put('initialized', true);
			state.storage.kv.put('pending-review', { snapshotId: 'previous' });
			const first = new ComputerMigration(state.storage, legacy, destination);
			expect(await first.batch()).toBe(false);
			expect(first.active).toBe(false);
			expect(first.status().cursor).not.toBe('');
			const resumed = new ComputerMigration(state.storage, legacy, destination);
			while (!(await resumed.batch())) {
				/* Resume durable batches. */
			}
			expect(resumed.active).toBe(true);
			expect(await destination.readFileBytes('/blob.bin')).toEqual(bytes);
			expect(await destination.readlink('/absolute')).toBe('/src.txt');
			expect(await destination.readlink('/relative')).toBe('src.txt');
			expect(await destination.readFile('/.git/objects/history')).toBe('git history');
			expect(await destination.readFile('/.agent/snapshots/previous/src.txt')).toBe('before uncommitted edit');
			expect(await destination._getAllPaths()).toEqual(await legacy._getAllPaths());
			expect(await legacy.readFileBytes('/blob.bin')).toEqual(bytes);
			expect(state.storage.kv.get('initialized')).toBe(true);
			expect(state.storage.kv.get('pending-review')).toEqual({ snapshotId: 'previous' });
		});
	});

	it('fails verification without switching storage and retries a fresh copy after legacy changes', async () => {
		const stub = env.DurableObjectFilesystem.getByName(`migration-failure:${crypto.randomUUID()}`);
		await runInDurableObject(stub, async (_instance, state) => {
			const legacy = new Workspace({ sql: state.storage.sql });
			const destination = new ComputerWorkspace(new Computer({ storage: computerStorage(state.storage) }));
			await legacy.writeFile('/source.txt', 'original');
			const migration = new ComputerMigration(state.storage, legacy, destination);
			expect(await migration.batch()).toBe(false);
			await destination.writeFile('/source.txt', 'corrupt');
			await expect(migration.batch()).rejects.toThrow('Legacy SQLite and R2 data remain intact');
			expect(migration.active).toBe(false);
			expect(await legacy.readFile('/source.txt')).toBe('original');
			await legacy.rm('/source.txt');
			await legacy.writeFile('/replacement.txt', 'usable during failure');
			await migration.retry();
			while (!(await migration.batch())) {
				/* Complete retry. */
			}
			expect(await destination.exists('/source.txt')).toBe(false);
			expect(await destination.readFile('/replacement.txt')).toBe('usable during failure');
		});
	});

	it('keeps missing R2 blobs recoverable', async () => {
		const stub = env.DurableObjectFilesystem.getByName(`migration-blob:${crypto.randomUUID()}`);
		await runInDurableObject(stub, async (_instance, state) => {
			const prefix = `migration-missing/${state.id}`;
			const legacy = new Workspace({ sql: state.storage.sql, r2: env.STORAGE_BUCKET, r2Prefix: prefix });
			await legacy.writeFileBytes('/blob', new Uint8Array(1_600_000).fill(42));
			await legacy.writeFile('/safe.txt', 'still readable');
			const blobs = await env.STORAGE_BUCKET.list({ prefix });
			for (const blob of blobs.objects) await env.STORAGE_BUCKET.delete(blob.key);
			const migration = new ComputerMigration(
				state.storage,
				legacy,
				new ComputerWorkspace(new Computer({ storage: computerStorage(state.storage) })),
			);
			await expect(migration.batch()).rejects.toThrow('migration failed');
			expect(migration.active).toBe(false);
			expect(await legacy.readFile('/safe.txt')).toBe('still readable');
		});
	});
	it('keeps the original project usable when the destination runs out of capacity', async () => {
		const project = env.DurableObjectFilesystem.getByName(`capacity:${crypto.randomUUID()}`);
		await runInDurableObject(project, async (_instance, state) => {
			const legacy = new Workspace({ sql: state.storage.sql });
			await legacy.writeFile('/source.txt', 'original');
			const destination = new ComputerWorkspace(new Computer({ storage: computerStorage(state.storage) }));
			const write = vi.spyOn(destination, 'writeFileBytes').mockRejectedValueOnce(new Error('SQLITE_FULL: workspace capacity exhausted'));
			const migration = new ComputerMigration(state.storage, legacy, destination);
			await expect(migration.batch()).rejects.toThrow('capacity exhausted');
			expect(migration.active).toBe(false);
			expect(await legacy.readFile('/source.txt')).toBe('original');
			write.mockRestore();
			await migration.retry();
			while (!(await migration.batch())) {
				/* resumable retry */
			}
			expect(migration.active).toBe(true);
		});
	});
});
