/**
 * Possible status values for a file in the git working tree.
 *
 * The values map to isomorphic-git statusMatrix [HEAD, WORKDIR, STAGE]:
 * - untracked:                [0, 2, 0] — new file not yet staged
 * - untracked-staged:         [0, 2, 2] — new file, fully staged
 * - untracked-partially-staged: [0, 2, 3] — new file, staged version differs from working
 * - unmodified:               [1, 1, 1] — clean, committed
 * - modified:                 [1, 2, 1] — modified in workdir, not staged
 * - modified-staged:          [1, 2, 2] — modified, fully staged
 * - modified-partially-staged: [1, 2, 3] — modified, staged version differs from working
 * - deleted:                  [1, 0, 1] — deleted in workdir, not staged
 * - deleted-staged:           [1, 0, 0] — deleted, staged for removal
 * - added:                    [0, 2, 2] — alias for untracked-staged in simplified views
 */
export type GitFileStatus =
	| 'untracked'
	| 'untracked-staged'
	| 'untracked-partially-staged'
	| 'unmodified'
	| 'modified'
	| 'modified-staged'
	| 'modified-partially-staged'
	| 'deleted'
	| 'deleted-staged';
export interface GitStatusEntry {
	path: string;
	status: GitFileStatus;
	staged: boolean;
	headStatus: number;
	workdirStatus: number;
	stageStatus: number;
}
export interface GitBranchInfo {
	name: string;
	isCurrent: boolean;
}
export interface GitAuthor {
	name: string;
	email: string;
	timestamp: number;
}
export interface GitCommitEntry {
	objectId: string;
	abbreviatedObjectId: string;
	message: string;
	author: GitAuthor;
	parentObjectIds: string[];
}
export interface GitGraphConnection {
	fromColumn: number;
	toColumn: number;
	color: string;
}
export interface GitGraphEntry extends GitCommitEntry {
	column: number;
	connections: GitGraphConnection[];
	branchNames: string[];
	tagNames: string[];
}
export interface GitDiffLine {
	type: 'add' | 'remove' | 'context';
	content: string;
}
export interface GitDiffHunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: GitDiffLine[];
}
export interface GitFileDiff {
	path: string;
	status: 'modified' | 'added' | 'deleted';
	hunks: GitDiffHunk[];
	beforeContent?: string;
	afterContent?: string;
}
export interface GitMergeResult {
	objectId?: string;
	alreadyMerged?: boolean;
	fastForward?: boolean;
	conflicts?: string[];
}
