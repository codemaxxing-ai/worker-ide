import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { runWithProjectStub } from './project-fs';
import { createProjectFileSystem } from './workspace-client';
import { addFileToSnapshot, initSnapshot } from '../services/agent/snapshot-manager';

describe('Computer review and mutation boundaries', () => {
	it('initializes a Code snapshot after Plan and Ask turns before tools are assembled', async () => {
		const project = env.DurableObjectFilesystem.getByName(crypto.randomUUID());
		for (const mode of ['plan', 'ask']) {
			if (mode !== 'plan' && mode !== 'ask') continue;
			await project.beginComputerSessionTurn('session', `${mode}-turn`, mode);
			await expect(
				(async () => {
					await project.wsMkdir('/blocked', true, 'session');
				})(),
			).rejects.toThrow('cannot mutate');
			await project.beginComputerSessionTurn('session', `${mode}-to-code`, 'code');
			const snapshot = await runWithProjectStub(project, () => initSnapshot('/project', 'session', [], () => {}), '/project', 'session');
			expect(await project.wsExists(`/.agent/snapshots/${snapshot.id}/metadata.json`)).toBe(true);
		}
	});

	it('reviews and rejects state writes through a chained file symlink', async () => {
		const project = env.DurableObjectFilesystem.getByName(crypto.randomUUID());
		await project.wsWriteFile('/src/source.txt', 'baseline');
		await project.wsSymlink('/src/source.txt', '/alias');
		await project.wsSymlink('alias', '/indirect');
		const filesystem = createProjectFileSystem(project, '/project', 'session');
		const snapshot = await runWithProjectStub(project, () => initSnapshot('/project', 'session', [], () => {}), '/project', 'session');
		await filesystem.writeFile('/project/indirect', 'changed');
		const changes = await project.drainWorkspaceChanges('session');
		expect(changes).toMatchObject([{ path: '/src/source.txt', beforeContent: 'baseline', afterContent: 'changed' }]);
		expect(changes).toHaveLength(1);
		await runWithProjectStub(
			project,
			() =>
				addFileToSnapshot(snapshot, { path: '/src/source.txt', action: 'edit', beforeContent: changes[0]?.beforeContent, isBinary: false }),
			'/project',
			'session',
		);
		const restored = await project.restoreSnapshots([{ snapshotId: snapshot.id }]);
		expect(restored.failed).toEqual([]);
		expect(await filesystem.readFile('/project/indirect', 'utf8')).toBe('baseline');
		expect(await project.wsReadlink('/alias')).toBe('/src/source.txt');
	});

	it('tracks binary writes, appends and new files through parent and dangling symlinks', async () => {
		const project = env.DurableObjectFilesystem.getByName(crypto.randomUUID());
		await project.wsWriteFileBytes('/src/binary', new Uint8Array([0, 255]));
		await project.wsWriteFile('/src/text', 'baseline');
		await project.wsSymlink('/src', '/shortcut');
		await project.wsSymlink('/src/new.txt', '/new-link');
		const filesystem = createProjectFileSystem(project, '/project', 'session');
		await filesystem.writeFile('/project/shortcut/binary', new Uint8Array([0, 128, 42]));
		await filesystem.appendFile('/project/shortcut/text', ' appended');
		await filesystem.writeFile('/project/new-link', 'created');
		const changes = await project.drainWorkspaceChanges('session');
		expect(changes).toHaveLength(3);
		expect(changes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: '/src/binary', isBinary: true, beforeBytes: 'AP8=', afterBytes: 'AIAq' }),
				expect.objectContaining({ path: '/src/text', beforeContent: 'baseline', afterContent: 'baseline appended' }),
				expect.objectContaining({ path: '/src/new.txt', type: 'create', afterContent: 'created' }),
			]),
		);
	});

	it('restores replaced directories before children and removes new children before restoring files', async () => {
		const project = env.DurableObjectFilesystem.getByName(crypto.randomUUID());
		await project.wsWriteFileBytes('/.agent/snapshots/types/directory/child.bin', new Uint8Array([0, 255, 128]));
		await project.wsWriteFile('/.agent/snapshots/types/directory/link', 'child.bin');
		await project.wsWriteFile('/.agent/snapshots/types/file', 'original file');
		await project.wsWriteFile(
			'/.agent/snapshots/types/metadata.json',
			JSON.stringify({
				changes: [
					{ path: '/directory/child.bin', action: 'delete', beforeEntryType: 'file' },
					{ path: '/directory/link', action: 'delete', beforeEntryType: 'symlink' },
					{ path: '/directory', action: 'edit', beforeEntryType: 'directory', entryType: 'file' },
					{ path: '/file', action: 'edit', beforeEntryType: 'file', entryType: 'directory' },
					{ path: '/file/nested', action: 'create', entryType: 'directory' },
					{ path: '/file/nested/new.txt', action: 'create', entryType: 'file' },
				],
			}),
		);
		await project.wsWriteFile('/directory', 'replaced directory');
		await project.wsWriteFile('/file/nested/new.txt', 'new child');
		const result = await project.restoreSnapshots([{ snapshotId: 'types' }]);
		expect(result.failed).toEqual([]);
		expect(result.reverted).toHaveLength(6);
		expect(await project.wsLstat('/directory')).toMatchObject({ type: 'directory' });
		expect(await project.wsReadFileBytes('/directory/child.bin')).toEqual(new Uint8Array([0, 255, 128]));
		expect(await project.wsReadlink('/directory/link')).toBe('child.bin');
		expect(await project.wsReadFile('/file')).toBe('original file');
	});

	it('rejects Plan and Ask writes at the RPC boundary, including state helper calls', async () => {
		const project = env.DurableObjectFilesystem.getByName(crypto.randomUUID());
		await project.writeFileContent('/source.txt', 'readable');
		for (const mode of ['plan', 'ask']) {
			if (mode !== 'plan' && mode !== 'ask') continue;
			await project.registerComputerSession(mode, mode);
			await project.writeAgentDocument('plan', mode, 'read-only plan');
			await project.writeAgentDocument('todos', mode, '[]');
			const plan = await project.wsReadFile(`/.agent/plans/${mode}.md`);
			expect(plan).toBe('read-only plan');
			await expect(
				(async () => {
					await project.wsWriteFile('/source.txt', 'forbidden', mode);
				})(),
			).rejects.toThrow('cannot mutate');
			await expect(
				(async () => {
					await project.wsMkdir('/forbidden', true, mode);
				})(),
			).rejects.toThrow('cannot mutate');
			await expect(
				(async () => {
					await project.computerApplyTool('write', { path: '/source.txt', content: 'forbidden' }, mode);
				})(),
			).rejects.toThrow('cannot mutate');
			await expect(
				(async () => {
					await project.computerExec('echo forbidden > source.txt', { id: crypto.randomUUID() }, mode);
				})(),
			).rejects.toThrow('cannot mutate');
		}
		expect(await project.wsReadFile('/source.txt')).toBe('readable');
		await expect(
			(async () => {
				await project.writeAgentDocument('plan', '../source', 'escape');
			})(),
		).rejects.toThrow('Invalid agent document session');
	});

	it('restores binary bytes, symlink targets and removed directories without following links', async () => {
		const project = env.DurableObjectFilesystem.getByName(crypto.randomUUID());
		const bytes = new Uint8Array([0, 255, 128, 42]);
		await project.wsWriteFileBytes('/.agent/snapshots/first/data', bytes);
		await project.wsWriteFile('/.agent/snapshots/first/link', 'data');
		await project.wsWriteFile(
			'/.agent/snapshots/first/metadata.json',
			JSON.stringify({
				changes: [
					{ path: '/data', action: 'edit', isBinary: true, beforeEntryType: 'file', entryType: 'file' },
					{ path: '/link', action: 'edit', beforeEntryType: 'symlink', entryType: 'file' },
					{ path: '/empty', action: 'delete', beforeEntryType: 'directory', entryType: 'directory' },
				],
			}),
		);
		await project.wsWriteFile('/data', 'changed');
		await project.wsWriteFile('/link', 'regular file');
		const restored = await project.restoreSnapshots([{ snapshotId: 'first' }]);
		expect(restored.failed).toEqual([]);
		expect(await project.wsReadFileBytes('/data')).toEqual(bytes);
		expect(await project.wsReadlink('/link')).toBe('data');
		expect(await project.wsReadFileBytes('/link')).toEqual(bytes);
		expect(await project.wsLstat('/empty')).toMatchObject({ type: 'directory' });
	});

	it('rejects a binary review through the same queued RPC used by the editor', async () => {
		const project = env.DurableObjectFilesystem.getByName(crypto.randomUUID());
		const bytes = new Uint8Array([0, 255, 128, 42]);
		await project.wsWriteFileBytes('/.agent/snapshots/binary/data', bytes);
		await project.wsWriteFile(
			'/.agent/snapshots/binary/metadata.json',
			JSON.stringify({ changes: [{ path: '/data', action: 'edit', isBinary: true }] }),
		);
		await project.wsWriteFile('/data', 'changed');
		expect(
			await project.resolveWorkspaceReview({
				entry: {
					id: 'binary-review',
					path: '/data',
					action: 'edit',
					beforeContent: undefined,
					afterContent: undefined,
					snapshotId: 'binary',
					status: 'pending',
					hunkStatuses: [],
					latestSessionId: 'session',
					sessionIds: ['session'],
					diffSignature: 'binary',
					updatedAt: Date.now(),
				},
				hunkStatuses: [],
				finalizing: true,
				decision: 'reject',
			}),
		).toBe(true);
		expect(await project.wsReadFileBytes('/data')).toEqual(bytes);
	});

	it('reports missing backups while preserving the working tree', async () => {
		const project = env.DurableObjectFilesystem.getByName(crypto.randomUUID());
		await project.wsWriteFile(
			'/.agent/snapshots/missing/metadata.json',
			JSON.stringify({ changes: [{ path: '/source.txt', action: 'edit' }] }),
		);
		await project.wsWriteFile('/source.txt', 'usable');
		const result = await project.restoreSnapshots([{ snapshotId: 'missing' }]);
		expect(result.failed).toMatchObject([{ path: '/source.txt', error: expect.stringContaining('Missing snapshot backup') }]);
		expect(await project.wsReadFile('/source.txt')).toBe('usable');
	});
	it('preserves binary baselines larger than a SQLite row limit', async () => {
		const project = env.DurableObjectFilesystem.getByName(crypto.randomUUID());
		const original = new Uint8Array(2_500_000).fill(255);
		await project.wsWriteFileBytes('/large.bin', original);
		await project.wsWriteFileBytes('/large.bin', new Uint8Array([0, 128, 42]), 'binary-session');
		const changes = await project.drainWorkspaceChanges('binary-session');
		expect(changes).toMatchObject([{ path: '/large.bin', isBinary: true, afterBytes: 'AIAq' }]);
		expect(changes[0]?.beforeBytes).toHaveLength(Math.ceil(original.length / 3) * 4);
		expect(changes[0]?.beforeBytes?.slice(0, 8)).toBe('////////');
	});

	it('preserves large text baselines as text through queued editor writes', async () => {
		const project = env.DurableObjectFilesystem.getByName(crypto.randomUUID());
		const original = 'editor text\n'.repeat(200_000);
		await project.wsWriteFile('/large.txt', original);
		await project.wsWriteFile('/large.txt', 'command change', 'text-session');
		const changes = await project.drainWorkspaceChanges('text-session');
		expect(changes).toMatchObject([{ path: '/large.txt', isBinary: false, afterContent: 'command change' }]);
		expect(changes[0]?.beforeContent).toBe(original);
	});
});
