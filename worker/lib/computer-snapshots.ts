import { z } from 'zod';

import { computerPath, projectPath } from './computer-workspace';

import type { WorkspaceLike } from './workspace-fs-adapter';

const changeSchema = z.object({
	path: z.string(),
	action: z.enum(['create', 'edit', 'delete']),
	entryType: z.enum(['file', 'directory', 'symlink']).optional(),
	beforeEntryType: z.enum(['file', 'directory', 'symlink']).optional(),
});
const metadataSchema = z.object({ changes: z.array(changeSchema) });

function restorePhase(entry: z.infer<typeof changeSchema>): number {
	return entry.action === 'create' ? 1 : entry.beforeEntryType === 'directory' ? 0 : 2;
}

/** Restore a complete review selection under one mutation queue lease. */
export async function restoreComputerSnapshots(workspace: WorkspaceLike, selections: Array<{ snapshotId: string; path?: string }>) {
	const reverted: Array<{ path: string; snapshotId: string; action: 'create' | 'edit' | 'delete' }> = [];
	const failed: Array<{ path: string; snapshotId: string; action: 'create' | 'edit' | 'delete'; error: string }> = [];
	const missingSnapshots: string[] = [];
	const changes = new Map<string, { snapshotId: string; change: z.infer<typeof changeSchema> }>();
	for (const selection of selections.toReversed()) {
		if (!/^[\w-]+$/.test(selection.snapshotId)) throw new Error('Invalid snapshot ID');
		const raw = await workspace.readFile(`/.agent/snapshots/${selection.snapshotId}/metadata.json`);
		if (typeof raw !== 'string') {
			missingSnapshots.push(selection.snapshotId);
			continue;
		}
		for (const change of metadataSchema.parse(JSON.parse(raw)).changes) {
			if (selection.path && selection.path !== change.path) continue;
			const path = projectPath(computerPath(change.path));
			if (path === '/' || path === '/.agent' || path === '/.git' || path.startsWith('/.agent/') || path.startsWith('/.git/'))
				throw new Error('Snapshot contains a protected path');
			if (!changes.has(path)) changes.set(path, { snapshotId: selection.snapshotId, change });
		}
	}
	// Restore old directories first, remove new entries deepest-first, then
	// restore files/links after their directory structure is available.
	for (const [path, { snapshotId, change }] of [...changes].toSorted(([left, leftEntry], [right, rightEntry]) => {
		const leftPhase = restorePhase(leftEntry.change);
		const rightPhase = restorePhase(rightEntry.change);
		if (leftPhase !== rightPhase) return leftPhase - rightPhase;
		const depth = left.split('/').length - right.split('/').length;
		return leftPhase === 1 ? -depth : depth;
	})) {
		const result = { path, snapshotId, action: change.action };
		try {
			if (change.action === 'create') {
				await workspace.rm(path, { recursive: change.entryType === 'directory', force: true });
			} else {
				const beforeType = change.beforeEntryType ?? 'file';
				const backup = `/.agent/snapshots/${snapshotId}${path}`;
				// Read backups before touching the working tree: missing backups must leave it usable.
				const bytes = beforeType === 'directory' ? undefined : await workspace.readFileBytes(backup);
				if (beforeType !== 'directory' && !bytes) throw new Error(`Missing snapshot backup: ${backup}`);
				const current = await workspace.lstat(path);
				if (current && (current.type !== beforeType || current.type === 'symlink'))
					await workspace.rm(path, { recursive: current.type === 'directory', force: true });
				await workspace.mkdir(path.slice(0, path.lastIndexOf('/')) || '/', { recursive: true });
				if (beforeType === 'directory') await workspace.mkdir(path, { recursive: true });
				else if (beforeType === 'symlink' && bytes) await workspace.symlink(new TextDecoder().decode(bytes), path);
				else if (bytes) await workspace.writeFileBytes(path, bytes);
			}
			reverted.push(result);
		} catch (error) {
			failed.push({ ...result, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { reverted, failed, missingSnapshots };
}
