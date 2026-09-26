import type { StoreState } from '@/lib/store';
import type { GitBranchInfo, GitStatusEntry } from '@shared/types';
import type { StateCreator } from 'zustand';

/**
 * Read-only diff view for displaying git file diffs in the editor.
 * Separate from `pendingChanges` (which is for AI change review with accept/reject).
 */
interface GitDiffView {
	path: string;
	beforeContent: string;
	afterContent: string;
	description?: string;
}

export interface GitState {
	gitStatus: GitStatusEntry[];
	gitBranches: GitBranchInfo[];
	gitStatusLoading: boolean;
	gitInitialized: boolean;
	gitDiffView: GitDiffView | undefined;
}

export interface GitActions {
	setGitStatus: (entries: GitStatusEntry[]) => void;
	setGitBranches: (branches: GitBranchInfo[]) => void;
	setGitStatusLoading: (loading: boolean) => void;
	setGitInitialized: (initialized: boolean) => void;
	showGitDiff: (diffView: GitDiffView) => void;
	clearGitDiff: () => void;
}

export const createGitSlice: StateCreator<StoreState, [['zustand/devtools', never]], [], GitState & GitActions> = (set) => ({
	gitStatus: [],
	gitBranches: [],
	gitStatusLoading: false,
	gitInitialized: false,
	gitDiffView: undefined,

	setGitStatus: (entries) => set({ gitStatus: entries }),

	setGitBranches: (branches) => set({ gitBranches: branches }),

	setGitStatusLoading: (loading) => set({ gitStatusLoading: loading }),

	setGitInitialized: (initialized) => set({ gitInitialized: initialized }),

	showGitDiff: (diffView) =>
		set((state) => ({
			gitDiffView: diffView,
			// Also open the file and make it active so the editor shows it
			openFiles: state.openFiles.includes(diffView.path) ? state.openFiles : [...state.openFiles, diffView.path],
			activeFile: diffView.path,
			activeMobilePanel: 'editor',
		})),

	clearGitDiff: () => set({ gitDiffView: undefined }),
});
