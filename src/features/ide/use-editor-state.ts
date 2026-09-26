import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useChangeReview } from '@/features/agent/hooks/use-change-review';
import {
	computeDiffData,
	computeRebasedDiffData,
	groupHunksIntoChanges,
	resolveReviewContent,
	useFileContent,
} from '@/features/editor/index';
import { dispatchLintDiagnostics } from '@/features/editor/lib/lint-extension';
import { projectSocketSendReference } from '@/hooks/index';
import { fixFile, isLintableFile } from '@/lib/biome-linter';
import { selectGitDiffView, selectGitStatus, useStore } from '@/lib/store';

import type { EditorView } from '@codemirror/view';

export function useEditorState({ projectId }: { projectId: string }) {
	const {
		activeFile,
		openFiles,
		unsavedChanges,
		closeFile,
		markFileChanged,
		setCursorPosition,
		setFileScrollPosition,
		setFileCursorPosition,
		goToFilePosition,
		clearPendingGoTo,
		pendingGoTo,
		pendingChanges,
		participants,
		cursorPosition,
	} = useStore(
		useShallow((state) => ({
			activeFile: state.activeFile,
			openFiles: state.openFiles,
			unsavedChanges: state.unsavedChanges,
			closeFile: state.closeFile,
			markFileChanged: state.markFileChanged,
			setCursorPosition: state.setCursorPosition,
			setFileScrollPosition: state.setFileScrollPosition,
			setFileCursorPosition: state.setFileCursorPosition,
			goToFilePosition: state.goToFilePosition,
			clearPendingGoTo: state.clearPendingGoTo,
			pendingGoTo: state.pendingGoTo,
			pendingChanges: state.pendingChanges,
			participants: state.participants,
			cursorPosition: state.cursorPosition,
		})),
	);

	// Git diff view (read-only git diffs in the editor)
	const gitDiffView = useStore(selectGitDiffView);
	const clearGitDiff = useStore((state) => state.clearGitDiff);

	// Git status for file tree coloring
	const gitStatusEntries = useStore(selectGitStatus);
	const gitStatusMap = useMemo(() => {
		const map = new Map<string, import('@shared/types').GitFileStatus>();
		for (const entry of gitStatusEntries) {
			if (entry.status !== 'unmodified') {
				map.set(entry.path, entry.status);
			}
		}
		return map;
	}, [gitStatusEntries]);

	// File content hook. The query cache is the single source of on-disk truth.
	const { content, isLoading: isLoadingContent, saveFile, isSaving } = useFileContent({ projectId, path: activeFile });

	// The pending AI change for the active file, if any.
	const activePendingChange = activeFile ? pendingChanges.get(activeFile) : undefined;
	const hasActiveDiff = activePendingChange?.status === 'pending' && activePendingChange.action !== 'move';

	// The base document the editor should display. When the active file has a
	// review entry this is the review-resolved content (on-disk content with
	// rejected hunks reverted), computed with the exact algorithm the server
	// uses to persist a resolution — so what the user sees equals what accepting
	// would write. With all hunks still pending it is the agent's after-content,
	// giving the inline diff its "after" lines to highlight; once hunks are
	// accepted/rejected it reflects those decisions instantly. Otherwise it is
	// the raw on-disk content. This is a pure function of the query cache and the
	// review state — no imperative cache writes drive the display.
	const displayedContent = useMemo(() => {
		if (!activePendingChange) return content;
		const resolution = resolveReviewContent({
			action: activePendingChange.action,
			beforeContent: activePendingChange.beforeContent,
			agentAfterContent: activePendingChange.afterContent,
			liveContent: content,
			hunkStatuses: activePendingChange.hunkStatuses,
			finalizing: false,
		});
		return resolution.action === 'delete' ? content : resolution.content;
	}, [activePendingChange, content]);

	// Track local editor edits (in-flight typing). Highest precedence so a
	// background refetch never clobbers what the user is typing.
	const [localEditorContent, setLocalEditorContent] = useState<string>();

	// Reset local edits when the displayed base content changes (agent revision,
	// collaborator edit, save) or when switching files — but only once the query
	// has finished loading, since while loading `content` is '' and would wipe
	// in-progress edits. Keyed on activeFile too so switching between two files
	// with identical content still drops the previous file's buffer.
	const [previousBase, setPreviousBase] = useState<{ file: string | undefined; content: string }>({
		file: activeFile,
		content: displayedContent,
	});
	if (!isLoadingContent && (previousBase.file !== activeFile || previousBase.content !== displayedContent)) {
		setPreviousBase({ file: activeFile, content: displayedContent });
		setLocalEditorContent(undefined);
	}

	const editorContent = localEditorContent ?? displayedContent ?? '';
	const changeReview = useChangeReview({
		projectId,
		getLiveContent: (path) => (path === activeFile ? editorContent : undefined),
	});

	// Compute inline diff decorations for the active file (if it has a pending AI
	// change). editorContent already equals the after/resolved content, so this
	// renders a straight before -> displayed diff.
	const activeDiffData = useMemo(() => {
		if (!activePendingChange || activePendingChange.status !== 'pending') return;
		return computeRebasedDiffData(activePendingChange.beforeContent, activePendingChange.afterContent, editorContent);
	}, [activePendingChange, editorContent]);

	// Synchronously initialize per-hunk statuses when a diff is first displayed.
	// Uses the render-time setState pattern (like previousBase above) to avoid
	// a one-frame gap where hunkStatuses is [] while changeGroups is non-empty.
	if (activeFile && activeDiffData && activePendingChange && activePendingChange.hunkStatuses.length === 0) {
		const changeGroups = groupHunksIntoChanges(activeDiffData.hunks);
		if (changeGroups.length > 0) {
			const statuses = changeGroups.map(() => 'pending' as const);
			useStore.setState((state) => {
				const newMap = new Map(state.pendingChanges);
				const change = newMap.get(activeFile);
				if (change && change.hunkStatuses.length === 0) {
					newMap.set(activeFile, { ...change, hunkStatuses: statuses });
				}
				return { pendingChanges: newMap };
			});
		}
	}

	// Compute git diff data when a read-only git diff view is active
	const isGitDiffActive = !!gitDiffView && gitDiffView.path === activeFile;
	const gitDiffData = useMemo(() => {
		if (!gitDiffView || gitDiffView.path !== activeFile) return;
		return computeDiffData(gitDiffView.beforeContent, gitDiffView.afterContent);
	}, [gitDiffView, activeFile]);

	// Git diff takes priority over AI diff when both exist for the same file
	const effectiveDiffData = gitDiffData ?? activeDiffData;

	// Build tabs data — add label when git diff is active
	const tabs = openFiles.map((path) => ({
		path,
		hasUnsavedChanges: unsavedChanges.get(path) ?? false,
		isSaving: isSaving && path === activeFile,
		label: gitDiffView?.path === path ? `${path.split('/').pop() ?? path} (${gitDiffView.description ?? 'Working Changes'})` : undefined,
	}));

	// Handle editor content changes
	const handleEditorChange = useCallback(
		(newContent: string, position?: { line: number; column: number; anchorLine: number; anchorColumn: number }) => {
			setLocalEditorContent(newContent);
			if (!activeFile) return;

			const cursor = position ? { line: position.line, ch: position.column } : undefined;
			const hasSelection = position && (position.line !== position.anchorLine || position.column !== position.anchorColumn);
			const selection = hasSelection
				? {
						anchor: { line: position.anchorLine, ch: position.anchorColumn },
						head: { line: position.line, ch: position.column },
					}
				: undefined;

			if (position) {
				const cursorValue = { line: position.line, column: position.column };
				setCursorPosition(cursorValue);
				setFileCursorPosition(activeFile, cursorValue);
			}

			projectSocketSendReference.current?.({
				type: 'file-edit',
				path: activeFile,
				content: newContent,
				...(cursor ? { cursor } : {}),
				...(selection ? { selection } : {}),
			});

			if (pendingChanges.get(activeFile)?.status === 'pending') {
				markFileChanged(activeFile, true);
				return;
			}

			if (newContent !== content) {
				markFileChanged(activeFile, true);
			}
		},
		[activeFile, content, markFileChanged, pendingChanges, setCursorPosition, setFileCursorPosition],
	);

	// Handle save
	const handleSave = useCallback(async () => {
		if (activeFile && unsavedChanges.get(activeFile)) {
			try {
				await saveFile(editorContent);
				markFileChanged(activeFile, false);
			} catch {
				// Save failed — keep the dirty flag so the user knows
			}
		}
	}, [activeFile, unsavedChanges, saveFile, editorContent, markFileChanged]);

	// Ref to keep handleSave stable
	const handleSaveReference = useRef(handleSave);
	useEffect(() => {
		handleSaveReference.current = handleSave;
	}, [handleSave]);

	// Auto-save when the editor loses focus (onFocusChange, like VS Code)
	const handleEditorBlur = useCallback(() => {
		void handleSaveReference.current();
	}, []);

	// Editor view ref for direct CodeMirror dispatch (preserves scroll position)
	const editorViewReference = useRef<EditorView | undefined>(undefined);
	const scrollListenerReference = useRef<(() => void) | undefined>(undefined);

	const handleViewReady = useCallback(
		(view?: EditorView) => {
			// Clean up previous scroll listener
			scrollListenerReference.current?.();
			scrollListenerReference.current = undefined;

			editorViewReference.current = view;

			if (view && activeFile) {
				// Restore saved cursor position for this file (if no pending goTo).
				// Clamp to the document length so stale positions from edited files
				// don't throw.
				const pending = useStore.getState().pendingGoTo;
				if (!pending) {
					const savedCursor = useStore.getState().fileCursorPositions.get(activeFile);
					if (savedCursor) {
						const maxLine = view.state.doc.lines;
						const clampedLine = Math.min(savedCursor.line, maxLine);
						const lineObject = view.state.doc.line(clampedLine);
						const maxColumn = lineObject.length + 1;
						const clampedColumn = Math.min(savedCursor.column, maxColumn);
						const offset = lineObject.from + clampedColumn - 1;
						view.dispatch({ selection: { anchor: offset } });
					}
				}

				// Restore saved scroll position for this file.
				// Read from the store directly to avoid a stale closure.
				// Clamp to the actual scrollable range so shortened files don't
				// leave the editor stuck past the end.
				const savedScroll = useStore.getState().fileScrollPositions.get(activeFile);
				if (savedScroll !== undefined && savedScroll > 0) {
					requestAnimationFrame(() => {
						const maxScroll = view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight;
						view.scrollDOM.scrollTop = Math.min(savedScroll, Math.max(0, maxScroll));
					});
				}

				// Track scroll position changes (throttled to reduce store churn)
				let scrollThrottleId: ReturnType<typeof setTimeout> | undefined;
				const scrollHandler = () => {
					if (scrollThrottleId !== undefined) return;
					scrollThrottleId = setTimeout(() => {
						scrollThrottleId = undefined;
						const currentFile = useStore.getState().activeFile;
						if (currentFile) {
							setFileScrollPosition(currentFile, view.scrollDOM.scrollTop);
						}
					}, 150);
				};
				view.scrollDOM.addEventListener('scroll', scrollHandler, { passive: true });
				scrollListenerReference.current = () => {
					view.scrollDOM.removeEventListener('scroll', scrollHandler);
					clearTimeout(scrollThrottleId);
				};
			}
		},
		[activeFile, setFileScrollPosition],
	);

	// Clean up scroll listener on unmount
	useEffect(() => {
		return () => {
			scrollListenerReference.current?.();
		};
	}, []);

	// Prettify: apply all Biome fixes + formatting to the active file
	const [isPrettifying, setIsPrettifying] = useState(false);
	const handlePrettify = useCallback(async () => {
		if (!activeFile || isGitDiffActive) return;
		setIsPrettifying(true);
		try {
			const result = await fixFile(projectId, activeFile, editorContent);
			if (!result || result.content === editorContent) return;

			// Dispatch directly through CodeMirror to preserve scroll position.
			const view = editorViewReference.current;
			if (view) {
				view.dispatch({
					changes: { from: 0, to: view.state.doc.length, insert: result.content },
				});
			} else {
				setLocalEditorContent(result.content);
			}

			// Immediately dispatch remaining diagnostics to the output panel
			dispatchLintDiagnostics(activeFile, result.remainingDiagnostics);

			if (activeFile) {
				markFileChanged(activeFile, true);
			}
		} finally {
			setIsPrettifying(false);
		}
	}, [activeFile, editorContent, isGitDiffActive, markFileChanged, projectId]);

	// Wrap selectFile from file tree: autosave current file before switching + clear git diff
	// Also save current scroll position before switching to the new file
	const selectFileFromTree = useCallback(
		(path: string) => {
			// Save scroll and cursor position for the file we are leaving
			if (activeFile && editorViewReference.current) {
				setFileScrollPosition(activeFile, editorViewReference.current.scrollDOM.scrollTop);
			}
			if (activeFile && cursorPosition) {
				setFileCursorPosition(activeFile, cursorPosition);
			}
			void handleSaveReference.current();
			if (gitDiffView && gitDiffView.path !== path) {
				clearGitDiff();
			}
		},
		[activeFile, cursorPosition, gitDiffView, clearGitDiff, setFileScrollPosition, setFileCursorPosition],
	);

	// Wrap closeFile: autosave current file before closing + clear git diff if closing diffed file
	const handleCloseFile = useCallback(
		(path: string) => {
			void handleSaveReference.current();
			if (gitDiffView?.path === path) {
				clearGitDiff();
			}
			closeFile(path);
		},
		[closeFile, gitDiffView, clearGitDiff],
	);

	// Send cursor updates to collaborators (debounced)
	const cursorUpdateTimeoutReference = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const handleCursorChange = useCallback(
		(position: { line: number; column: number; anchorLine: number; anchorColumn: number }) => {
			const cursorValue = { line: position.line, column: position.column };
			setCursorPosition(cursorValue);
			if (activeFile) {
				setFileCursorPosition(activeFile, cursorValue);
			}

			// Debounce WebSocket cursor update
			clearTimeout(cursorUpdateTimeoutReference.current);
			cursorUpdateTimeoutReference.current = setTimeout(() => {
				const hasSelection = position.line !== position.anchorLine || position.column !== position.anchorColumn;
				projectSocketSendReference.current?.({
					type: 'cursor-update',
					file: activeFile ?? '',
					cursor: { line: position.line, ch: position.column },
					...(hasSelection
						? {
								selection: {
									anchor: { line: position.anchorLine, ch: position.anchorColumn },
									head: { line: position.line, ch: position.column },
								},
							}
						: {}),
				});
			}, 100);
		},
		[setCursorPosition, setFileCursorPosition, activeFile],
	);

	return {
		// File & content
		activeFile,
		openFiles,
		unsavedChanges,
		participants,
		cursorPosition,
		isLoadingContent,
		isSaving,
		editorContent,
		tabs,

		// Diff state
		gitDiffView,
		clearGitDiff,
		isGitDiffActive,
		hasActiveDiff,
		activePendingChange,
		effectiveDiffData,
		changeReview,

		// Git status
		gitStatusMap,

		// Handlers
		handleEditorChange,
		handleSave,
		handleSaveReference,
		handleEditorBlur,
		handleViewReady,
		handlePrettify,
		isPrettifying,
		handleCloseFile,
		handleCursorChange,
		selectFileFromTree,
		cursorUpdateTimeoutReference,

		// GoTo
		pendingGoTo,
		clearPendingGoTo,
		goToFilePosition,

		// Pending changes (for store access)
		pendingChanges,
		markFileChanged,

		// Linting
		isLintableFile,
	};
}
