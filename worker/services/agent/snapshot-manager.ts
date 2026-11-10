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
	const promptText =
		typeof lastUserMessage?.content === 'string'
			? lastUserMessage.content
			: (lastUserMessage?.content ?? [])
					.filter((part) => part.type === 'text')
					.map((part) => part.text)
					.join('\n');
	const label = promptText.slice(0, 50) + (promptText.length > 50 ? '...' : '');

	const metadata: SnapshotMetadata = {
		id: snapshotId,
		timestamp: Date.now(),
		label,
		sessionId,
		changes: [],
	};
	await fs.writeFile(`${snapshotDirectory}/metadata.json`, JSON.stringify(metadata, undefined, 2));

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
	try {
		const metadataPath = `${context.directory}/metadata.json`;
		const metadata: SnapshotMetadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
		if (metadata.changes.some((entry) => entry.path === change.path)) {
			context.savedPaths.add(change.path);
			return;
		}
		if (change.action !== 'create' && change.beforeContent !== undefined) {
			const path = `${context.directory}${change.path}`;
			const directory = path.slice(0, path.lastIndexOf('/'));
			if (directory && directory !== context.directory) await fs.mkdir(directory, { recursive: true });
			await fs.writeFile(path, change.beforeContent);
		}
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
