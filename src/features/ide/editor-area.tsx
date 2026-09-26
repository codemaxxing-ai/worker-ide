import { EditorView } from '@codemirror/view';
import { Package, Sparkles } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { EditorSkeleton, WranglerSettingsSkeleton } from '@/components/ui/skeleton';
import { Tooltip } from '@/components/ui/tooltip';
import { useAgentRuntime } from '@/features/agent/components/agent-runtime-context';
import { isAgentState } from '@/features/agent/lib/agent-state';
import { useCollabCursors } from '@/features/editor/hooks/use-collab-cursors';
import { CodeEditor, DiffFloatingBar, FileTabs, GitDiffToolbar, groupHunksIntoChanges } from '@/features/editor/index';
import { isLintableFile } from '@/lib/biome-linter';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { isProtectedSystemFile } from '@shared/constants';

import type { useEditorState } from './use-editor-state';
import type { PendingFileChange } from '@shared/types';

const WranglerSettingsPanel = lazy(() =>
	import('@/features/project-settings/wrangler-settings-panel').then((m) => ({ default: m.WranglerSettingsPanel })),
);

type EditorState = ReturnType<typeof useEditorState>;

interface HunkSessionReference {
	sessionId: string;
	label: string;
}

function buildSessionLabel(sessionId: string, title?: string): string {
	return title?.trim() || `Session ${sessionId.slice(0, 8)}`;
}

function buildVisibleHunkSessionIds(change: PendingFileChange, groupCount: number): string[][] {
	if (groupCount === 0) {
		return [];
	}

	const fallbackSessionIds = change.sessionIds?.length === 1 ? change.sessionIds : [change.sessionId];
	return Array.from({ length: groupCount }, (_, index) => {
		const sessionIds = change.hunkSessionIds?.[index]?.filter(Boolean);
		return sessionIds && sessionIds.length > 0 ? [...new Set(sessionIds)] : fallbackSessionIds;
	});
}

interface EditorAreaProperties {
	projectId: string;
	resolvedTheme: 'light' | 'dark';
	editorState: EditorState;
	onSelectFile: (path: string) => void;
	tabsPrefix?: React.ReactNode;
}

export function EditorArea({ projectId, resolvedTheme, editorState, onSelectFile, tabsPrefix }: EditorAreaProperties) {
	const {
		activeFile,
		tabs,
		participants,
		isLoadingContent,
		editorContent,
		gitDiffView,
		clearGitDiff,
		isGitDiffActive,
		hasActiveDiff,
		activePendingChange,
		effectiveDiffData,
		changeReview,
		handleEditorChange,
		handleEditorBlur,
		handleViewReady,
		handlePrettify,
		isPrettifying,
		handleCloseFile,
		handleCursorChange,
		pendingGoTo,
		clearPendingGoTo,
	} = editorState;

	const closeAllFiles = useStore((state) => state.closeAllFiles);
	const requestAgentSession = useStore((state) => state.requestAgentSession);
	const { agent } = useAgentRuntime();
	const agentState = isAgentState(agent.state) ? agent.state : undefined;
	const sessionLabelById = useMemo(
		() => new Map((agentState?.sessions ?? []).map((session) => [session.id, buildSessionLabel(session.id, session.title)])),
		[agentState?.sessions],
	);

	// Track whether the active file has fixable lint issues (to show/hide prettify FAB).
	// We store [filePath, hasFixable] so that when activeFile changes the stale value
	// is detected during render and reset without needing setState-in-effect.
	const [fixableState, setFixableState] = useState<[string | undefined, boolean]>([activeFile, false]);
	const hasFixableIssues = fixableState[0] === activeFile && fixableState[1];
	if (fixableState[0] !== activeFile) {
		setFixableState([activeFile, false]);
	}
	useEffect(() => {
		const handler = (event: Event) => {
			if (!(event instanceof CustomEvent)) return;
			const detail: { filePath: string; diagnostics: Array<{ fixable: boolean }> } = event.detail;
			if (detail.filePath === activeFile) {
				setFixableState([activeFile, detail.diagnostics.some((d) => d.fixable)]);
			}
		};
		globalThis.addEventListener('lint-diagnostics', handler);
		return () => globalThis.removeEventListener('lint-diagnostics', handler);
	}, [activeFile]);

	// Remote collaboration cursors extension
	const { extension: collabCursorsExtension, handleViewReady: handleCollabViewReady } = useCollabCursors(activeFile);

	// Editor view ref for hunk navigation (scrolling to change groups)
	const editorViewReference = useRef<EditorView | undefined>(undefined);

	// Combine the editor state's view-ready handler with the collab cursors handler
	const combinedHandleViewReady = useCallback(
		(view?: EditorView) => {
			editorViewReference.current = view;
			handleViewReady(view);
			handleCollabViewReady(view);
		},
		[handleViewReady, handleCollabViewReady],
	);

	// Compute change groups from the active diff data for the floating bar
	const changeGroups = useMemo(
		() => (hasActiveDiff && effectiveDiffData ? groupHunksIntoChanges(effectiveDiffData.hunks) : []),
		[hasActiveDiff, effectiveDiffData],
	);
	const hunkSessionReferences = useMemo<Array<HunkSessionReference[]>>(() => {
		if (!activePendingChange) {
			return [];
		}

		return buildVisibleHunkSessionIds(activePendingChange, changeGroups.length).map((sessionIds) =>
			sessionIds.map((sessionId) => ({
				sessionId,
				label: sessionLabelById.get(sessionId) ?? buildSessionLabel(sessionId),
			})),
		);
	}, [activePendingChange, changeGroups.length, sessionLabelById]);

	// Track which change group the user is currently viewing
	const [currentGroupIndex, setCurrentGroupIndex] = useState(0);

	// Reset current index when the file or diff changes
	const previousDiffKeyReference = useRef<string | undefined>(undefined);
	const diffKey = activeFile && hasActiveDiff ? `${activeFile}:${effectiveDiffData?.hunks.length}` : undefined;
	if (diffKey !== previousDiffKeyReference.current) {
		previousDiffKeyReference.current = diffKey;
		if (currentGroupIndex !== 0) {
			setCurrentGroupIndex(0);
		}
	}

	// Clamp index when changeGroups shrinks (e.g. after user edits recompute the diff)
	if (changeGroups.length > 0 && currentGroupIndex >= changeGroups.length) {
		setCurrentGroupIndex(changeGroups.length - 1);
	}

	// Navigate to a change group by scrolling the editor to its start line
	const handleNavigateToGroup = useCallback(
		(groupIndex: number) => {
			setCurrentGroupIndex(groupIndex);
			const view = editorViewReference.current;
			const group = changeGroups[groupIndex];
			if (!view || !group) return;

			const lineNumber = Math.min(group.startLine, view.state.doc.lines);
			const line = view.state.doc.line(lineNumber);
			view.dispatch({
				selection: { anchor: line.from },
				effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
			});
			view.focus();
		},
		[changeGroups],
	);

	const handleOpenAgentSession = useCallback(
		(targetSessionId: string) => {
			requestAgentSession(targetSessionId);
		},
		[requestAgentSession],
	);

	const showPrettifyAction = !!activeFile && !isGitDiffActive && !isProtectedSystemFile(activeFile) && isLintableFile(activeFile);

	return (
		<>
			<div className="flex items-stretch">
				{tabsPrefix}
				<FileTabs
					tabs={tabs}
					activeTab={activeFile}
					onSelect={onSelectFile}
					onClose={handleCloseFile}
					onCloseAll={closeAllFiles}
					actions={
						showPrettifyAction ? (
							<Tooltip content="Prettify (Shift+Alt+F)">
								<Button
									type="button"
									focusStyle="inset"
									variant="ghost"
									size="icon"
									onClick={() => void handlePrettify()}
									isLoading={isPrettifying}
									className={cn('size-7', 'text-text-secondary', 'hover:text-accent')}
									aria-label="Prettify file"
								>
									<Sparkles className={cn('size-3.5', hasFixableIssues && 'text-accent')} />
								</Button>
							</Tooltip>
						) : undefined
					}
					participants={participants}
					className="min-w-0 flex-1"
				/>
			</div>
			{isGitDiffActive && activeFile && gitDiffView && (
				<GitDiffToolbar path={activeFile} description={gitDiffView.description ?? 'Working Changes'} onClose={clearGitDiff} />
			)}
			<div className="relative flex-1 overflow-hidden">
				{activeFile ? (
					activeFile === '/wrangler.jsonc' ? (
						<Suspense fallback={<WranglerSettingsSkeleton />}>
							<WranglerSettingsPanel projectId={projectId} />
						</Suspense>
					) : isLoadingContent ? (
						<EditorSkeleton />
					) : (
						<>
							{isProtectedSystemFile(activeFile) && <ProtectedFileBanner path={activeFile} />}
							<CodeEditor
								projectId={projectId}
								value={isGitDiffActive && gitDiffView ? gitDiffView.afterContent : editorContent}
								filename={activeFile}
								onChange={isGitDiffActive || isProtectedSystemFile(activeFile) ? undefined : handleEditorChange}
								onCursorChange={handleCursorChange}
								onBlur={isGitDiffActive || hasActiveDiff || isProtectedSystemFile(activeFile) ? undefined : handleEditorBlur}
								goToPosition={pendingGoTo}
								onGoToPositionConsumed={clearPendingGoTo}
								readonly={isGitDiffActive || isProtectedSystemFile(activeFile)}
								diffData={effectiveDiffData}
								hunkStatuses={hasActiveDiff ? activePendingChange?.hunkStatuses : undefined}
								onDiffApprove={
									hasActiveDiff && activeFile && !isGitDiffActive
										? (groupIndex: number) => changeReview.handleApproveHunk(activeFile, groupIndex)
										: undefined
								}
								onDiffReject={
									hasActiveDiff && activeFile && !isGitDiffActive
										? (groupIndex: number) => changeReview.handleRejectHunk(activeFile, groupIndex)
										: undefined
								}
								hunkSessionReferences={hasActiveDiff ? hunkSessionReferences : undefined}
								onOpenDiffSession={hasActiveDiff ? handleOpenAgentSession : undefined}
								resolvedTheme={resolvedTheme}
								extensions={[collabCursorsExtension]}
								onViewReady={combinedHandleViewReady}
							/>
							{!isGitDiffActive && hasActiveDiff && activeFile && activePendingChange && (
								<DiffFloatingBar
									changeGroups={changeGroups}
									hunkStatuses={activePendingChange.hunkStatuses}
									currentGroupIndex={currentGroupIndex}
									onNavigate={handleNavigateToGroup}
									onAcceptAll={changeReview.handleApproveChange}
									onRejectAll={changeReview.handleRejectChange}
									path={activeFile}
									isReverting={changeReview.isReverting}
									canReject={changeReview.canReject && !!activePendingChange.reviewId}
								/>
							)}
						</>
					)
				) : (
					<div className="flex h-full items-center justify-center text-text-secondary">
						<p>Select a file to edit</p>
					</div>
				)}
			</div>
		</>
	);
}

function ProtectedFileBanner({ path }: { path: string }) {
	const showDependenciesPanel = useStore((state) => state.showDependenciesPanel);
	const isPackageJson = path === '/package.json';

	return (
		<div
			className="
				flex shrink-0 items-center gap-2 border-b border-border bg-bg-secondary px-3
				py-1.5 text-xs text-text-secondary
			"
		>
			<Package className="size-3.5" />
			<span>This file is managed by the IDE and is read-only.</span>
			{isPackageJson && (
				<button
					type="button"
					onClick={showDependenciesPanel}
					className="
						cursor-pointer text-accent underline
						hover:text-accent-hover
					"
				>
					Open Dependencies panel
				</button>
			)}
		</div>
	);
}
