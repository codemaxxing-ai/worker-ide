export interface ComputerExecOptions {
	id: string;
	backend?: string;
	cwd?: string;
	env?: Record<string, string>;
	inputJson?: string;
	expectedSnapshotHash?: string;
	nativeRuntime?: boolean;
}

export interface ComputerExecResult {
	id: string;
	backend: string;
	status: 'completed' | 'failed' | 'cancelled';
	exitCode: number;
	stdout: string;
	stderr: string;
	syncStatus: 'complete' | 'pending';
	syncError?: string;
	valueJson?: string;
}
import type { ReviewEntry, ReviewHunkStatus, ReviewResolutionDecision } from './types/review';

export interface ComputerReviewOptions {
	entry: ReviewEntry;
	hunkStatuses: ReviewHunkStatus[];
	finalizing: boolean;
	liveContent?: string;
	decision?: ReviewResolutionDecision;
}
