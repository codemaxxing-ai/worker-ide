import type { StoreState } from '@/lib/store';
import type { StateCreator } from 'zustand';

// Ancestor directory paths of a file, e.g. "/src/lib/a.ts" -> ["/src", "/src/lib"].
function ancestorDirectories(path: string): string[] {
	const segments = path.split('/').filter(Boolean);
	segments.pop(); // drop the file leaf
	const ancestors: string[] = [];
	let current = '';
	for (const segment of segments) {
		current += `/${segment}`;
		ancestors.push(current);
	}
	return ancestors;
}

// Return an expandedDirs set that additionally reveals a file by expanding all
// of its ancestor directories (VS Code-style reveal on open). Returns the same
// reference when nothing changes so subscribers do not fire needlessly.
function withRevealedAncestors(expandedDirectories: Set<string>, path: string): Set<string> {
	const ancestors = ancestorDirectories(path);
	if (ancestors.every((directory) => expandedDirectories.has(directory))) return expandedDirectories;
	return new Set([...expandedDirectories, ...ancestors]);
}

export interface EditorState {
	activeFile: string | undefined;
	openFiles: string[];
	cursorPosition: { line: number; column: number } | undefined;
	pendingGoTo: { line: number; column: number } | undefined;
	unsavedChanges: Map<string, boolean>;
	fileScrollPositions: Map<string, number>;
	fileCursorPositions: Map<string, { line: number; column: number }>;
}

export interface EditorActions {
	setActiveFile: (path: string | undefined) => void;
	openFile: (path: string) => void;
	closeFile: (path: string) => void;
	setCursorPosition: (position: { line: number; column: number } | undefined) => void;
	goToFilePosition: (path: string, position: { line: number; column: number }) => void;
	clearPendingGoTo: () => void;
	markFileChanged: (path: string, changed: boolean) => void;
	closeAllFiles: () => void;
	setFileScrollPosition: (path: string, scrollTop: number) => void;
	restoreFileScrollPositions: (positions: Map<string, number>) => void;
	setFileCursorPosition: (path: string, position: { line: number; column: number }) => void;
}

export const createEditorSlice: StateCreator<StoreState, [['zustand/devtools', never]], [], EditorState & EditorActions> = (set) => ({
	activeFile: undefined,
	openFiles: [],
	cursorPosition: undefined,
	pendingGoTo: undefined,
	unsavedChanges: new Map(),
	fileScrollPositions: new Map(),
	fileCursorPositions: new Map(),

	setActiveFile: (path) => set({ activeFile: path, cursorPosition: undefined }),

	openFile: (path) =>
		set((state) => ({
			openFiles: state.openFiles.includes(path) ? state.openFiles : [...state.openFiles, path],
			activeFile: path,
			activeMobilePanel: 'editor',
			cursorPosition: undefined,
			expandedDirs: withRevealedAncestors(state.expandedDirs, path),
		})),

	closeFile: (path) =>
		set((state) => {
			const closedFileIndex = state.openFiles.indexOf(path);
			const newOpenFiles = state.openFiles.filter((f) => f !== path);
			const newUnsavedChanges = new Map(state.unsavedChanges);
			newUnsavedChanges.delete(path);
			const newFileScrollPositions = new Map(state.fileScrollPositions);
			newFileScrollPositions.delete(path);
			const newFileCursorPositions = new Map(state.fileCursorPositions);
			newFileCursorPositions.delete(path);
			const nextActiveFile =
				state.activeFile === path ? (newOpenFiles[closedFileIndex] ?? newOpenFiles[closedFileIndex - 1]) : state.activeFile;
			return {
				openFiles: newOpenFiles,
				activeFile: nextActiveFile,
				unsavedChanges: newUnsavedChanges,
				fileScrollPositions: newFileScrollPositions,
				fileCursorPositions: newFileCursorPositions,
			};
		}),

	setCursorPosition: (position) => set({ cursorPosition: position }),

	goToFilePosition: (path, position) =>
		set((state) => ({
			openFiles: state.openFiles.includes(path) ? state.openFiles : [...state.openFiles, path],
			activeFile: path,
			activeMobilePanel: 'editor',
			pendingGoTo: position,
			expandedDirs: withRevealedAncestors(state.expandedDirs, path),
		})),

	clearPendingGoTo: () => set({ pendingGoTo: undefined }),

	markFileChanged: (path, changed) =>
		set((state) => {
			const newUnsavedChanges = new Map(state.unsavedChanges);
			if (changed) {
				newUnsavedChanges.set(path, true);
			} else {
				newUnsavedChanges.delete(path);
			}
			return { unsavedChanges: newUnsavedChanges };
		}),

	closeAllFiles: () =>
		set({
			openFiles: [],
			activeFile: undefined,
			unsavedChanges: new Map(),
			fileScrollPositions: new Map(),
			fileCursorPositions: new Map(),
		}),

	setFileScrollPosition: (path, scrollTop) =>
		set((state) => {
			const newMap = new Map(state.fileScrollPositions);
			newMap.set(path, scrollTop);
			return { fileScrollPositions: newMap };
		}),

	restoreFileScrollPositions: (positions) => set({ fileScrollPositions: positions }),

	setFileCursorPosition: (path, position) =>
		set((state) => {
			const newMap = new Map(state.fileCursorPositions);
			newMap.set(path, position);
			return { fileCursorPositions: newMap };
		}),
});
