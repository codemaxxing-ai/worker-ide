export type ReviewHunkStatus = 'pending' | 'approved' | 'rejected';
export type ReviewResolutionDecision = 'accept' | 'reject' | 'mixed';

export interface ChangeSetFile {
	path: string;
	action: 'create' | 'edit' | 'delete' | 'move';
	beforeContent: string | undefined;
	afterContent: string | undefined;
	snapshotId: string | undefined;
	sessionId: string;
}

export interface ChangeSet {
	id: string;
	sessionId: string;
	snapshotId: string | undefined;
	createdAt: number;
	files: ChangeSetFile[];
}

export interface ReviewEntry {
	id: string;
	path: string;
	action: 'create' | 'edit' | 'delete' | 'move';
	beforeContent: string | undefined;
	afterContent: string | undefined;
	snapshotId: string | undefined;
	status: 'pending';
	hunkStatuses: ReviewHunkStatus[];
	hunkSessionIds?: string[][];
	latestSessionId: string;
	sessionIds: string[];
	diffSignature: string;
	updatedAt: number;
}

export interface ReviewSummary {
	unresolvedCount: number;
	reviewVersion: number;
	sessionCounts: Record<string, number>;
}

/**
 * A file change made by the AI that is pending user review.
 * The AI writes files immediately (for HMR preview), but the user
 * can approve (keep) or reject (revert) each change.
 */
export interface PendingFileChange {
	path: string;
	action: 'create' | 'edit' | 'delete' | 'move';
	beforeContent: string | undefined;
	afterContent: string | undefined;
	snapshotId: string | undefined;
	status: 'pending' | 'approved' | 'rejected';
	/**
	 * Per-change-group statuses for hunk-level accept/reject.
	 * Indices correspond to change groups computed by `groupHunksIntoChanges()`.
	 * Starts as `[]` and is populated when the diff is first displayed.
	 */
	hunkStatuses: ReviewHunkStatus[];
	hunkSessionIds?: string[][];
	sessionId: string;
	sessionIds?: string[];
	reviewId?: string;
}
export interface FileChange {
	path: string;
	action: 'create' | 'edit' | 'delete';
	beforeContent: string | undefined;
	afterContent: string | undefined;
	isBinary: boolean;
}
export interface SnapshotMetadata {
	id: string;
	timestamp: number;
	label: string;
	sessionId?: string;
	changes: Array<{
		path: string;
		action: 'create' | 'edit' | 'delete';
	}>;
}
export interface SnapshotSummary {
	id: string;
	timestamp: number;
	label: string;
	changeCount: number;
}
