import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

import { createAgentSlice } from '@/features/agent/state/agent-slice';
import { createPendingChangesSlice } from '@/features/agent/state/pending-ai-changes-slice';
import { createCollaborationSlice } from '@/features/collaboration/state/collaboration-slice';
import { createEditorSlice } from '@/features/editor/state/editor-slice';
import { createFileTreeSlice } from '@/features/file-tree/state/file-tree-slice';
import { createGitSlice } from '@/features/git/state/git-slice';
import { createUISlice } from '@/features/ide/state/ui-slice';
import { createSnapshotSlice } from '@/features/snapshots/state/snapshot-slice';
import { createIdentitySlice } from '@/features/user-menu/state/identity-slice';

import { type AgentState, type AgentActions } from '../features/agent/state/agent-slice';
import { type PendingChangesState, type PendingChangesActions } from '../features/agent/state/pending-ai-changes-slice';
import { type CollaborationState, type CollaborationActions } from '../features/collaboration/state/collaboration-slice';
import { type EditorState, type EditorActions } from '../features/editor/state/editor-slice';
import { type FileTreeState, type FileTreeActions } from '../features/file-tree/state/file-tree-slice';
import { type GitState, type GitActions } from '../features/git/state/git-slice';
import { type UIState, type UIActions } from '../features/ide/state/ui-slice';
import { type SnapshotState, type SnapshotActions } from '../features/snapshots/state/snapshot-slice';
import { type IdentityState, type IdentityActions } from '../features/user-menu/state/identity-slice';

export type StoreState = EditorState &
	FileTreeState &
	AgentState &
	CollaborationState &
	SnapshotState &
	PendingChangesState &
	IdentityState &
	UIState &
	GitState &
	EditorActions &
	FileTreeActions &
	AgentActions &
	CollaborationActions &
	SnapshotActions &
	PendingChangesActions &
	IdentityActions &
	UIActions &
	GitActions;

export const useStore = create<StoreState>()(
	devtools(
		(...arguments_) => ({
			...createEditorSlice(...arguments_),
			...createFileTreeSlice(...arguments_),
			...createAgentSlice(...arguments_),
			...createCollaborationSlice(...arguments_),
			...createSnapshotSlice(...arguments_),
			...createPendingChangesSlice(...arguments_),
			...createIdentitySlice(...arguments_),
			...createUISlice(...arguments_),
			...createGitSlice(...arguments_),
		}),
		{ name: 'WorkerIDE' },
	),
);

export const selectIsProcessing = (state: StoreState) => state.isProcessing;
export const selectColorScheme = (state: StoreState) => state.colorScheme;
export const selectEditorFont = (state: StoreState) => state.editorFont;
export const selectGitStatus = (state: StoreState) => state.gitStatus;
export const selectActiveSidebarView = (state: StoreState) => state.activeSidebarView;
export const selectGitChangedFileCount = (state: StoreState) => state.gitStatus.filter((entry) => entry.status !== 'unmodified').length;
export const selectGitDiffView = (state: StoreState) => state.gitDiffView;
export const selectOptimisticUserName = (state: StoreState) => state.optimisticUserName;
export { type MobilePanel, type SidebarView, type UtilityTab } from '../features/ide/state/ui-slice';
