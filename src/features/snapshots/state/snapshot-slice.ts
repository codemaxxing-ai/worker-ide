import type { StoreState } from '@/lib/store';
import type { SnapshotSummary } from '@shared/types';
import type { StateCreator } from 'zustand';

export interface SnapshotState {
	snapshots: SnapshotSummary[];
	activeSnapshot: string | undefined;
}

export interface SnapshotActions {
	setSnapshots: (snapshots: SnapshotSummary[]) => void;
	addSnapshot: (snapshot: SnapshotSummary) => void;
	setActiveSnapshot: (id: string | undefined) => void;
}

export const createSnapshotSlice: StateCreator<StoreState, [['zustand/devtools', never]], [], SnapshotState & SnapshotActions> = (set) => ({
	snapshots: [],
	activeSnapshot: undefined,

	setSnapshots: (snapshots) => set({ snapshots }),

	addSnapshot: (snapshot) =>
		set((state) => ({
			snapshots: [snapshot, ...state.snapshots].slice(0, 10),
		})),

	setActiveSnapshot: (id) => set({ activeSnapshot: id }),
});
