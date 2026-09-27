import type { PendingFileChange } from '@shared/types';
export function accumulatePendingChange(
	pendingChanges: Map<string, PendingFileChange>,
	change: Omit<PendingFileChange, 'status' | 'hunkStatuses'>,
): void {
	const existing = pendingChanges.get(change.path);

	if (!existing) {
		// Skip if content is identical (no actual change)
		if (change.action !== 'move' && change.beforeContent !== undefined && change.beforeContent === change.afterContent) {
			return;
		}
		pendingChanges.set(change.path, { ...change, status: 'pending', hunkStatuses: [] });
		return;
	}

	// Keep the first beforeContent and existing snapshotId for dedup
	const beforeContent = existing.beforeContent;
	const snapshotId = existing.snapshotId ?? change.snapshotId;
	const originalAction = existing.action;
	const newAction = change.action;

	// create -> delete = net no-op
	if (originalAction === 'create' && newAction === 'delete') {
		pendingChanges.delete(change.path);
		return;
	}

	// create -> edit = still a create (with updated content)
	if (originalAction === 'create' && newAction === 'edit') {
		if (beforeContent !== undefined && beforeContent === change.afterContent) {
			pendingChanges.delete(change.path);
			return;
		}
		pendingChanges.set(change.path, { ...change, action: 'create', beforeContent, snapshotId, status: 'pending', hunkStatuses: [] });
		return;
	}

	// delete -> create = effectively an edit
	if (originalAction === 'delete' && newAction === 'create') {
		if (beforeContent !== undefined && beforeContent === change.afterContent) {
			pendingChanges.delete(change.path);
			return;
		}
		pendingChanges.set(change.path, { ...change, action: 'edit', beforeContent, snapshotId, status: 'pending', hunkStatuses: [] });
		return;
	}

	// All other cases: keep original beforeContent, use new action & afterContent
	if (newAction !== 'move' && beforeContent !== undefined && beforeContent === change.afterContent) {
		pendingChanges.delete(change.path);
		return;
	}
	pendingChanges.set(change.path, { ...change, beforeContent, snapshotId, status: 'pending', hunkStatuses: [] });
}
