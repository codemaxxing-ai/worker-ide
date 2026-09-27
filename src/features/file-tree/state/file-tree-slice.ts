import type { StoreState } from '@/lib/store';
import type { FileInfo } from '@shared/types';
import type { StateCreator } from 'zustand';

export interface FileTreeState {
	files: FileInfo[];
	filesProjectId: string | undefined;
	// Directories are collapsed by default (VS Code style); this set tracks the
	// ones the user has expanded so the state survives reloads and re-syncs.
	expandedDirs: Set<string>;
	isLoading: boolean;
}

export interface FileTreeActions {
	setFiles: (files: FileInfo[], projectId?: string) => void;
	toggleDirectory: (path: string) => void;
	expandDirectory: (path: string) => void;
	collapseDirectory: (path: string) => void;
	setLoading: (loading: boolean) => void;
}

export const createFileTreeSlice: StateCreator<StoreState, [['zustand/devtools', never]], [], FileTreeState & FileTreeActions> = (set) => ({
	files: [],
	filesProjectId: undefined,
	expandedDirs: new Set(),
	isLoading: true,

	setFiles: (files, projectId) => set((state) => ({ files, filesProjectId: projectId ?? state.filesProjectId, isLoading: false })),

	toggleDirectory: (path) =>
		set((state) => {
			const expanded = new Set(state.expandedDirs);
			if (expanded.has(path)) {
				expanded.delete(path);
			} else {
				expanded.add(path);
			}
			return { expandedDirs: expanded };
		}),

	expandDirectory: (path) =>
		set((state) => {
			if (state.expandedDirs.has(path)) return {};
			return { expandedDirs: new Set([...state.expandedDirs, path]) };
		}),

	collapseDirectory: (path) =>
		set((state) => {
			if (!state.expandedDirs.has(path)) return {};
			const expanded = new Set(state.expandedDirs);
			expanded.delete(path);
			return { expandedDirs: expanded };
		}),

	setLoading: (loading) => set({ isLoading: loading }),
});
