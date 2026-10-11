import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

import { BINARY_EXTENSIONS } from '@shared/constants';
import { HttpErrorCode } from '@shared/http-errors';
import { snapshotIdSchema, revertFileSchema, revertCascadeSchema, filePathSchema, pendingChangesFileSchema } from '@shared/validation';
import { fs } from '@worker/lib/project-fs';

import { agentRunnerNamespace, coordinatorNamespace, filesystemNamespace } from '../lib/durable-object-namespaces';
import { httpError } from '../lib/http-error';
import { toDurableObjectId } from '../lib/project-id';

import type { AppEnvironment } from '../types';
interface SnapshotMetadata {
	id: string;
	timestamp: number;
	label: string;
	sessionId?: string;
	changes: Array<{
		path: string;
		action: 'create' | 'edit' | 'delete';
		isBinary?: boolean;
		entryType?: 'file' | 'directory' | 'symlink';
		beforeEntryType?: 'file' | 'directory' | 'symlink';
	}>;
}
export const snapshotRoutes = new Hono<AppEnvironment>()
	// GET /api/snapshots - List all snapshots
	.get('/snapshots', async (c) => {
		const projectRoot = c.get('projectRoot');
		const snapshots = await listSnapshots(projectRoot);
		return c.json({ snapshots });
	})

	// GET /api/snapshot/:id - Get snapshot details
	.get('/snapshot/:id', zValidator('param', z.object({ id: snapshotIdSchema })), async (c) => {
		const projectRoot = c.get('projectRoot');
		const { id } = c.req.valid('param');

		const metadata = await getSnapshotMetadata(projectRoot, id);
		if (!metadata) {
			throw httpError(HttpErrorCode.SNAPSHOT_NOT_FOUND, 'Snapshot not found');
		}

		return c.json({ snapshot: metadata });
	})

	// POST /api/snapshot/:id/revert - Revert entire snapshot
	.post('/snapshot/:id/revert', zValidator('param', z.object({ id: snapshotIdSchema })), async (c) => {
		const projectRoot = c.get('projectRoot');
		const projectId = c.get('projectId');
		const { id } = c.req.valid('param');

		const result = await revertSnapshot(projectRoot, id, projectId);
		if (!result.success) {
			if (result.reason === 'not_found') {
				throw httpError(HttpErrorCode.SNAPSHOT_NOT_FOUND, 'Snapshot not found');
			}
			throw httpError(HttpErrorCode.INTERNAL_ERROR, 'Failed to revert snapshot');
		}

		return c.json({ success: true });
	})

	// POST /api/snapshot/revert-file - Revert a single file from a snapshot
	.post('/snapshot/revert-file', zValidator('json', revertFileSchema), async (c) => {
		const projectRoot = c.get('projectRoot');
		const projectId = c.get('projectId');
		const { path, snapshotId } = c.req.valid('json');

		const result = await revertFileFromSnapshot(projectRoot, path, snapshotId, projectId);
		if (!result.success) {
			if (result.reason === 'not_found') {
				throw httpError(HttpErrorCode.NOT_FOUND, 'Snapshot or file not found');
			}
			throw httpError(HttpErrorCode.INTERNAL_ERROR, 'Failed to revert file');
		}

		return c.json({ success: true });
	})

	// POST /api/snapshots/revert-cascade - Revert multiple snapshots in reverse chronological order.
	// Deduplicates file paths across snapshots: when the same file appears in multiple
	// snapshots, only the earliest snapshot's backup is used (it has the true original content).
	.post('/snapshots/revert-cascade', zValidator('json', revertCascadeSchema), async (c) => {
		const projectRoot = c.get('projectRoot');
		const projectId = c.get('projectId');
		const { snapshotIds } = c.req.valid('json');

		const result = await revertCascade(projectRoot, snapshotIds, projectId);
		return c.json(result);
	})

	// GET /api/pending-changes - Load project-level pending changes from the agent
	.get('/pending-changes', async (c) => {
		try {
			const agentStub = agentRunnerNamespace.getByName(`agent:${c.get('projectId')}`);
			const response = await agentStub.fetch(
				new Request('http://agent/pending-changes', {
					headers: { 'x-partykit-room': `agent:${c.get('projectId')}` },
				}),
			);
			if (!response.ok) {
				throw new Error(await response.text());
			}
			const body: unknown = await response.json();
			const data = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
			return c.json(data);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to load pending changes';
			throw httpError(HttpErrorCode.INTERNAL_ERROR, message);
		}
	})

	// PUT /api/pending-changes - Save project-level pending changes to the agent
	.put('/pending-changes', zValidator('json', pendingChangesFileSchema), async (c) => {
		const changes = c.req.valid('json');
		try {
			const agentStub = agentRunnerNamespace.getByName(`agent:${c.get('projectId')}`);
			const response = await agentStub.fetch(
				new Request('http://agent/pending-changes', {
					method: 'PUT',
					headers: {
						'Content-Type': 'application/json',
						'x-partykit-room': `agent:${c.get('projectId')}`,
					},
					body: JSON.stringify(changes),
				}),
			);
			if (!response.ok) {
				throw new Error(await response.text());
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to save pending changes';
			throw httpError(HttpErrorCode.INTERNAL_ERROR, message);
		}
		return c.json({ success: true });
	})

	// GET /api/snapshot/:id/file?path=/src/main.ts - Get file content from snapshot
	.get(
		'/snapshot/:id/file',
		zValidator('param', z.object({ id: snapshotIdSchema })),
		zValidator('query', z.object({ path: filePathSchema })),
		async (c) => {
			const projectRoot = c.get('projectRoot');
			const { id } = c.req.valid('param');
			const { path } = c.req.valid('query');

			const snapshotDirectory = `${projectRoot}/.agent/snapshots/${id}`;
			const metadata = await getSnapshotMetadata(projectRoot, id);

			if (!metadata) {
				throw httpError(HttpErrorCode.SNAPSHOT_NOT_FOUND, 'Snapshot not found');
			}

			const change = metadata.changes.find((ch) => ch.path === path);
			if (!change) {
				throw httpError(HttpErrorCode.NOT_FOUND, 'File not in snapshot');
			}

			// For created files, there's no before content
			if (change.action === 'create') {
				return c.json({ path, content: undefined, action: 'create' });
			}

			try {
				const isBinary = change.isBinary ?? BINARY_EXTENSIONS.has(path.match(/\.[^.]+$/)?.[0]?.toLowerCase() ?? '');
				if (isBinary) {
					// For binary files, just indicate it exists
					return c.json({ path, content: undefined, action: change.action, isBinary: true });
				}

				const content = await fs.readFile(`${snapshotDirectory}${path}`, 'utf8');
				return c.json({ path, content, action: change.action });
			} catch {
				throw httpError(HttpErrorCode.FILE_NOT_FOUND, 'File not found in snapshot');
			}
		},
	);
async function listSnapshots(projectRoot: string): Promise<Array<{ id: string; timestamp: number; label: string; changeCount: number }>> {
	const snapshotsDirectory = `${projectRoot}/.agent/snapshots`;
	const snapshots: Array<{ id: string; timestamp: number; label: string; changeCount: number }> = [];

	try {
		const entries = await fs.readdir(snapshotsDirectory);
		for (const entry of entries) {
			try {
				const metadataPath = `${snapshotsDirectory}/${entry}/metadata.json`;
				const metadataRaw = await fs.readFile(metadataPath, 'utf8');
				const metadata: SnapshotMetadata = JSON.parse(metadataRaw);
				snapshots.push({
					id: metadata.id,
					timestamp: metadata.timestamp,
					label: metadata.label,
					changeCount: metadata.changes.length,
				});
			} catch {
				// Skip invalid snapshot directories
			}
		}
	} catch {
		// Snapshots directory may not exist yet
	}

	return snapshots.toSorted((a, b) => b.timestamp - a.timestamp);
}
async function getSnapshotMetadata(projectRoot: string, snapshotId: string): Promise<SnapshotMetadata | undefined> {
	try {
		const metadataPath = `${projectRoot}/.agent/snapshots/${snapshotId}/metadata.json`;
		const metadataRaw = await fs.readFile(metadataPath, 'utf8');
		const metadata: SnapshotMetadata = JSON.parse(metadataRaw);
		return metadata;
	} catch {
		return undefined;
	}
}
async function triggerRestoredFiles(projectId: string, paths: string[]) {
	const coordinator = coordinatorNamespace.getByName(`project:${projectId}`);
	for (const path of paths) {
		try {
			await coordinator.triggerUpdate({ type: 'full-reload', path, timestamp: Date.now(), targets: [] });
		} catch {
			/* Preview refresh is independent of durable restoration. */
		}
	}
}
async function revertSnapshot(
	_projectRoot: string,
	snapshotId: string,
	projectId: string,
): Promise<{ success: true } | { success: false; reason: 'not_found' | 'error' }> {
	const result = await filesystemNamespace.get(toDurableObjectId(filesystemNamespace, projectId)).restoreSnapshots([{ snapshotId }]);
	await triggerRestoredFiles(
		projectId,
		result.reverted.map((change) => change.path),
	);
	if (result.missingSnapshots.length > 0) return { success: false, reason: 'not_found' };
	if (result.failed.length > 0) return { success: false, reason: 'error' };
	return { success: true };
}
async function revertFileFromSnapshot(
	_projectRoot: string,
	path: string,
	snapshotId: string,
	projectId: string,
): Promise<{ success: true } | { success: false; reason: 'not_found' | 'error' }> {
	const result = await filesystemNamespace.get(toDurableObjectId(filesystemNamespace, projectId)).restoreSnapshots([{ snapshotId, path }]);
	await triggerRestoredFiles(
		projectId,
		result.reverted.map((change) => change.path),
	);
	if (result.failed.length > 0) return { success: false, reason: 'error' };
	if (result.reverted.length === 0) return { success: false, reason: 'not_found' };
	return { success: true };
}
interface CascadeRevertFileResult {
	path: string;
	snapshotId: string;
	action: 'create' | 'edit' | 'delete';
}
interface CascadeRevertResult {
	reverted: CascadeRevertFileResult[];
	failed: Array<CascadeRevertFileResult & { error: string }>;
	missingSnapshots: string[];
}

/**
 * Revert multiple snapshots in cascade (reverse chronological order).
 *
 * When the same file path appears in multiple snapshots, only the earliest
 * snapshot's backup is used — it contains the true original content before
 * any AI modifications in this sequence.
 *
 * Snapshots whose metadata cannot be found are reported in `missingSnapshots`
 * but do not cause the entire operation to fail.
 */
async function revertCascade(_projectRoot: string, snapshotIds: string[], projectId: string): Promise<CascadeRevertResult> {
	const result = await filesystemNamespace
		.get(toDurableObjectId(filesystemNamespace, projectId))
		.restoreSnapshots(snapshotIds.map((snapshotId) => ({ snapshotId })));
	await triggerRestoredFiles(
		projectId,
		result.reverted.map((change) => change.path),
	);
	return result;
}

export type SnapshotRoutes = typeof snapshotRoutes;
