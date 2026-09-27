import { useEffect, useRef } from 'react';

import { loadEditorSession, resolveEditorSession, saveEditorSession } from '@/lib/editor-session';
import { useStore } from '@/lib/store';

const SAVE_DEBOUNCE_MS = 500;
function buildSessionPayload() {
	const { openFiles, activeFile, fileScrollPositions, fileCursorPositions } = useStore.getState();
	return {
		openFiles,
		activeFile,
		scrollPositions: Object.fromEntries(fileScrollPositions),
		cursorPositions: Object.fromEntries(fileCursorPositions),
	};
}

/**
 * Persist editor session state (open tabs, active file, scroll/cursor
 * positions) to localStorage for the given project, and restore it on mount.
 */
export function useEditorSessionPersistence({ projectId }: { projectId: string }) {
	const restoredProjectIdReference = useRef<string | undefined>(undefined);

	// ── Restore on mount ──────────────────────────────────────────────
	// Wait until the file list has been loaded so we can filter out
	// tabs whose files no longer exist.
	const files = useStore((state) => state.files);
	const filesProjectId = useStore((state) => state.filesProjectId);
	const isLoading = useStore((state) => state.isLoading);

	useEffect(() => {
		if (restoredProjectIdReference.current === projectId) return;
		// Wait for the file list to finish loading before restoring
		if (isLoading || filesProjectId !== projectId) return;
		restoredProjectIdReference.current = projectId;

		const session = loadEditorSession(projectId);
		const existingPaths = new Set(files.map((file) => file.path));
		const resolved = resolveEditorSession(session, existingPaths);
		if (!resolved) {
			// No session to restore for this project. Clear any editor state left
			// over from a previously open project so its tabs don't leak across
			// the (non-remounting) project switch.
			useStore.getState().closeAllFiles();
			return;
		}

		useStore.setState({
			openFiles: resolved.openFiles,
			activeFile: resolved.activeFile,
			fileScrollPositions: resolved.scrollPositions,
			fileCursorPositions: resolved.cursorPositions,
		});
	}, [projectId, files, filesProjectId, isLoading]);

	// ── Persist on change (debounced) ─────────────────────────────────
	useEffect(() => {
		let saveTimeout: ReturnType<typeof setTimeout> | undefined;
		let lastProjectPayload = buildSessionPayload();
		const unsubscribe = useStore.subscribe((state, previousState) => {
			// Only save when relevant editor state changes
			const changed =
				state.openFiles !== previousState.openFiles ||
				state.activeFile !== previousState.activeFile ||
				state.fileScrollPositions !== previousState.fileScrollPositions ||
				state.fileCursorPositions !== previousState.fileCursorPositions;

			if (!changed) return;

			lastProjectPayload = buildSessionPayload();
			clearTimeout(saveTimeout);
			saveTimeout = setTimeout(() => {
				saveEditorSession(projectId, lastProjectPayload);
			}, SAVE_DEBOUNCE_MS);
		});

		return () => {
			unsubscribe();
			clearTimeout(saveTimeout);
			// Flush on unmount — but only if we have open files.
			// During React StrictMode teardown the store may already be empty;
			// flushing an empty session would overwrite the valid one.
			if (lastProjectPayload.openFiles.length > 0) {
				saveEditorSession(projectId, lastProjectPayload);
			}
		};
	}, [projectId]);
}
