import { fs } from '@worker/lib/project-fs';

import type { FileChange, SnapshotMetadata } from './types';
import type { ModelMessage } from 'ai';
export interface SnapshotContext {
	id: string;
	directory: string;
	savedPaths: Set<string>;
}

/**
 * Create a new snapshot directory and metadata file.
 *
 * Derives a label from the last user message and emits a
 * `snapshot_created` event via the provided `sendEvent` callback.
 */
export async function initSnapshot(
	projectRoot: string,
	sessionId: string | undefined,
	messages: ModelMessage[],
	sendEvent: (type: string, data: Record<string, unknown>) => void,
): Promise<SnapshotContext> {
	const snapshotId = crypto.randomUUID().slice(0, 8);
	const snapshotDirectory = `${projectRoot}/.agent/snapshots/${snapshotId}`;

	await fs.mkdir(snapshotDirectory, { recursive: true });

	// Derive label from the last user message
	const lastUserMessage = [...messages].toReversed().find((m) => m.role === 'user');
	const promptText = typeof lastUserMessage?.content === 'string' ? lastUserMessage.content : '';
	const label = promptText.slice(0, 50) + (promptText.length > 50 ? '...' : '');

	const metadata: SnapshotMetadata = {
		id: snapshotId,
		timestamp: Date.now(),
		label,
		sessionId,
		changes: [],
	};
	await fs.writeFile(`${snapshotDirectory}/metadata.json`, JSON.stringify(metadata, undefined, 2));

	await cleanupOldSnapshots(projectRoot, 10);

	sendEvent('snapshot_created', {
		id: snapshotId,
		label: metadata.label,
		timestamp: metadata.timestamp,
		changes: [],
	});

	return { id: snapshotId, directory: snapshotDirectory, savedPaths: new Set() };
}

/**
 * Add a file's "before" content to an existing snapshot.
 *
 * Skips files that were already saved (dedup via `savedPaths`).
 * Only saves content for non-create actions that have `beforeContent`.
 */
export async function addFileToSnapshot(context: SnapshotContext, change: FileChange): Promise<void> {
	if (context.savedPaths.has(change.path)) return;

	if (change.action !== 'create' && change.beforeContent !== undefined) {
		const filePath = `${context.directory}${change.path}`;
		const directory = filePath.slice(0, filePath.lastIndexOf('/'));
		if (directory && directory !== context.directory) {
			await fs.mkdir(directory, { recursive: true });
		}
		await fs.writeFile(filePath, change.beforeContent);
	}

	try {
		const metadataPath = `${context.directory}/metadata.json`;
		const raw = await fs.readFile(metadataPath, 'utf8');
		const metadata: SnapshotMetadata = JSON.parse(raw);
		metadata.changes.push({
			path: change.path,
			action: change.action,
			isBinary: change.isBinary || undefined,
			entryType: change.entryType,
			beforeEntryType: change.beforeEntryType,
		});
		await fs.writeFile(metadataPath, JSON.stringify(metadata, undefined, 2));
		context.savedPaths.add(change.path);
	} catch (error) {
		throw new Error(`Cannot save snapshot for ${change.path}`, { cause: error });
	}
}

/**
 * Remove old snapshots beyond the keep count.
 *
 * Session-aware cleanup (preserving snapshots referenced by surviving
 * pending changes) is handled separately by pruneOldSessions in the
 * AgentRunner DO.
 */
async function cleanupOldSnapshots(projectRoot: string, keepCount: number): Promise<void> {
	const snapshotsDirectory = `${projectRoot}/.agent/snapshots`;

	try {
		const entries = await fs.readdir(snapshotsDirectory);
		const snapshots: Array<{ id: string; timestamp: number }> = [];

		for (const entry of entries) {
			try {
				const metadataPath = `${snapshotsDirectory}/${entry}/metadata.json`;
				const metadataRaw = await fs.readFile(metadataPath, 'utf8');
				const metadata: SnapshotMetadata = JSON.parse(metadataRaw);
				snapshots.push({ id: entry, timestamp: metadata.timestamp });
			} catch {
				// No-op
			}
		}

		snapshots.sort((a, b) => b.timestamp - a.timestamp);

		for (const snapshot of snapshots.slice(keepCount)) {
			await deleteDirectoryRecursive(`${snapshotsDirectory}/${snapshot.id}`);
		}
	} catch {
		// No-op
	}
}
export async function deleteDirectoryRecursive(directoryPath: string): Promise<void> {
	try {
		const entries = await fs.readdir(directoryPath, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = `${directoryPath}/${entry.name}`;
			await (entry.isDirectory() ? deleteDirectoryRecursive(fullPath) : fs.unlink(fullPath));
		}
		await fs.rmdir(directoryPath);
	} catch {
		// No-op
	}
}
