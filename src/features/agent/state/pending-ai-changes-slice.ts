import type { StoreState } from '@/lib/store';
import type { PendingFileChange } from '@shared/types';
import type { StateCreator } from 'zustand';

export interface PendingChangesState {
	pendingChanges: Map<string, PendingFileChange>;
}

export interface PendingChangesActions {
	addPendingChange: (change: Omit<PendingFileChange, 'status' | 'hunkStatuses'>) => void;
	approveChange: (path: string) => void;
	rejectChange: (path: string) => void;
	approveHunk: (path: string, groupIndex: number) => void;
	rejectHunk: (path: string, groupIndex: number) => void;
	approveAllChanges: (sessionId?: string) => void;
	rejectAllChanges: (sessionId?: string) => void;
	clearPendingChanges: () => void;
	clearPendingChangesByPaths: (paths: Set<string>, sessionId?: string) => void;
	loadPendingChanges: (changes: Map<string, PendingFileChange>) => void;
}

export const createPendingChangesSlice: StateCreator<
	StoreState,
	[['zustand/devtools', never]],
	[],
	PendingChangesState & PendingChangesActions
> = (set) => ({
	pendingChanges: new Map(),

	addPendingChange: (change) =>
		set((state) => {
			const newMap = new Map(state.pendingChanges);
			const existing = newMap.get(change.path);

			if (!existing) {
				// Move actions always show (no content diff needed)
				// For other actions, skip if content is identical (no actual change)
				if (change.action !== 'move' && change.beforeContent !== undefined && change.beforeContent === change.afterContent) {
					return { pendingChanges: newMap };
				}
				newMap.set(change.path, { ...change, status: 'pending', hunkStatuses: [] });
				return { pendingChanges: newMap };
			}

			// Keep the first beforeContent and existing snapshotId for dedup
			const beforeContent = existing.beforeContent;
			const snapshotId = existing.snapshotId ?? change.snapshotId;

			// Resolve combined action based on original + new action
			const originalAction = existing.action;
			const newAction = change.action;

			// create → delete = net no-op (file never existed in snapshot)
			if (originalAction === 'create' && newAction === 'delete') {
				newMap.delete(change.path);
				return { pendingChanges: newMap };
			}

			// create → edit = still a create (with updated content)
			if (originalAction === 'create' && newAction === 'edit') {
				// If the final content matches the original beforeContent, it's a no-op
				if (beforeContent !== undefined && beforeContent === change.afterContent) {
					newMap.delete(change.path);
					return { pendingChanges: newMap };
				}
				newMap.set(change.path, {
					...change,
					action: 'create',
					beforeContent,
					snapshotId,
					status: 'pending',
					hunkStatuses: [],
				});
				return { pendingChanges: newMap };
			}

			// delete → create = effectively an edit (file was replaced)
			if (originalAction === 'delete' && newAction === 'create') {
				// If recreated content matches original, it's a no-op
				if (beforeContent !== undefined && beforeContent === change.afterContent) {
					newMap.delete(change.path);
					return { pendingChanges: newMap };
				}
				newMap.set(change.path, {
					...change,
					action: 'edit',
					beforeContent,
					snapshotId,
					status: 'pending',
					hunkStatuses: [],
				});
				return { pendingChanges: newMap };
			}

			// All other cases: keep original beforeContent, use new action & afterContent
			// If the net result is no change, remove the entry
			if (newAction !== 'move' && beforeContent !== undefined && beforeContent === change.afterContent) {
				newMap.delete(change.path);
				return { pendingChanges: newMap };
			}
			newMap.set(change.path, { ...change, beforeContent, snapshotId, status: 'pending', hunkStatuses: [] });
			return { pendingChanges: newMap };
		}),

	approveChange: (path) =>
		set((state) => {
			const newMap = new Map(state.pendingChanges);
			const change = newMap.get(path);
			if (change) {
				newMap.set(path, {
					...change,
					status: 'approved',
					hunkStatuses: change.hunkStatuses.map((status) => (status === 'pending' ? 'approved' : status)),
				});
			}
			return { pendingChanges: newMap };
		}),

	rejectChange: (path) =>
		set((state) => {
			const newMap = new Map(state.pendingChanges);
			const change = newMap.get(path);
			if (change) {
				newMap.set(path, {
					...change,
					status: 'rejected',
					hunkStatuses: change.hunkStatuses.map((status) => (status === 'pending' ? 'rejected' : status)),
				});
			}
			return { pendingChanges: newMap };
		}),

	approveHunk: (path, groupIndex) =>
		set((state) => {
			const newMap = new Map(state.pendingChanges);
			const change = newMap.get(path);
			if (!change) return { pendingChanges: newMap };

			const newStatuses = [...change.hunkStatuses];
			newStatuses[groupIndex] = 'approved';

			// If all hunks are resolved (no pending left), mark the whole file.
			// Mixed decisions (some approved, some rejected) are treated as 'approved'
			// since the user explicitly approved this hunk — partial accept beats stuck pending.
			const allResolved = newStatuses.every((status) => status !== 'pending');

			newMap.set(path, {
				...change,
				hunkStatuses: newStatuses,
				status: allResolved ? 'approved' : 'pending',
			});
			return { pendingChanges: newMap };
		}),

	rejectHunk: (path, groupIndex) =>
		set((state) => {
			const newMap = new Map(state.pendingChanges);
			const change = newMap.get(path);
			if (!change) return { pendingChanges: newMap };

			const newStatuses = [...change.hunkStatuses];
			newStatuses[groupIndex] = 'rejected';

			// If all hunks are resolved (no pending left), mark the whole file
			// If all hunks are resolved (no pending left), mark the whole file.
			// Mixed decisions (some approved, some rejected) are treated as 'rejected'
			// since the user explicitly rejected this hunk — partial reject beats stuck pending.
			const allResolved = newStatuses.every((status) => status !== 'pending');

			newMap.set(path, {
				...change,
				hunkStatuses: newStatuses,
				status: allResolved ? 'rejected' : 'pending',
			});
			return { pendingChanges: newMap };
		}),

	approveAllChanges: (sessionId) =>
		set((state) => {
			const newMap = new Map<string, PendingFileChange>();
			for (const [key, value] of state.pendingChanges) {
				const matchesSession = !sessionId || value.sessionId === sessionId;
				if (value.status === 'pending' && matchesSession) {
					newMap.set(key, {
						...value,
						status: 'approved',
						hunkStatuses: value.hunkStatuses.map((status) => (status === 'pending' ? 'approved' : status)),
					});
				} else {
					newMap.set(key, value);
				}
			}
			return { pendingChanges: newMap };
		}),

	rejectAllChanges: (sessionId) =>
		set((state) => {
			const newMap = new Map<string, PendingFileChange>();
			for (const [key, value] of state.pendingChanges) {
				const matchesSession = !sessionId || value.sessionId === sessionId;
				if (value.status === 'pending' && matchesSession) {
					newMap.set(key, {
						...value,
						status: 'rejected',
						hunkStatuses: value.hunkStatuses.map((status) => (status === 'pending' ? 'rejected' : status)),
					});
				} else {
					newMap.set(key, value);
				}
			}
			return { pendingChanges: newMap };
		}),

	clearPendingChanges: () => set({ pendingChanges: new Map() }),

	clearPendingChangesByPaths: (paths, sessionId) =>
		set((state) => {
			const newMap = new Map<string, PendingFileChange>();
			for (const [key, value] of state.pendingChanges) {
				const matchesPath = paths.has(key);
				const matchesSession = sessionId === undefined || value.sessionId === sessionId;
				if (!(matchesPath && matchesSession)) {
					newMap.set(key, value);
				}
			}
			return { pendingChanges: newMap };
		}),

	loadPendingChanges: (changes) => set({ pendingChanges: changes }),
});
