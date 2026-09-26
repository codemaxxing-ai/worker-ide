import { computeDiffHunkSessionIds, computeDiffHunks, groupHunksIntoChanges } from '@shared/review-diff';

import { changeSetFiles, reviewEntries, reviewEntrySources } from '../../durable/db/schema';

import type {
	PendingFileChange,
	ReviewEntry as SharedReviewEntry,
	ReviewHunkStatus,
	ReviewHunkStatus as SharedReviewHunkStatus,
	ReviewResolutionDecision,
	ReviewSummary,
} from '@shared/types';

type ChangeSetFileRow = typeof changeSetFiles.$inferSelect;
type ReviewEntrySourceRow = typeof reviewEntrySources.$inferSelect;

function parsePendingChangesRecord(raw: string): Record<string, PendingFileChange> {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return {};
		}
		const record: Record<string, PendingFileChange> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (!value || typeof value !== 'object' || Array.isArray(value)) {
				continue;
			}
			const pendingChange = value;
			if (
				typeof pendingChange.path !== 'string' ||
				typeof pendingChange.action !== 'string' ||
				typeof pendingChange.sessionId !== 'string'
			) {
				continue;
			}
			const rawHunkStatuses: unknown[] = Array.isArray(pendingChange.hunkStatuses) ? pendingChange.hunkStatuses : [];
			const rawHunkSessionIds = parseHunkSessionIds(pendingChange.hunkSessionIds);
			const rawSessionIds: unknown[] = Array.isArray(pendingChange.sessionIds) ? pendingChange.sessionIds : [];
			record[key] = {
				path: pendingChange.path,
				action:
					pendingChange.action === 'create' ||
					pendingChange.action === 'edit' ||
					pendingChange.action === 'delete' ||
					pendingChange.action === 'move'
						? pendingChange.action
						: 'edit',
				beforeContent: typeof pendingChange.beforeContent === 'string' ? pendingChange.beforeContent : undefined,
				afterContent: typeof pendingChange.afterContent === 'string' ? pendingChange.afterContent : undefined,
				snapshotId: typeof pendingChange.snapshotId === 'string' ? pendingChange.snapshotId : undefined,
				status: pendingChange.status === 'approved' || pendingChange.status === 'rejected' ? pendingChange.status : 'pending',
				hunkStatuses: rawHunkStatuses.filter(
					(status): status is ReviewHunkStatus => status === 'pending' || status === 'approved' || status === 'rejected',
				),
				hunkSessionIds: rawHunkSessionIds,
				sessionId: pendingChange.sessionId,
				sessionIds: rawSessionIds.filter((sessionId): sessionId is string => typeof sessionId === 'string'),
				reviewId: typeof pendingChange.reviewId === 'string' ? pendingChange.reviewId : undefined,
			};
		}
		return record;
	} catch {
		return {};
	}
}

function parseStringArray(raw: string): string[] {
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
	} catch {
		return [];
	}
}

function parseHunkStatuses(raw: string): ReviewHunkStatus[] {
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed.filter((status): status is ReviewHunkStatus => status === 'pending' || status === 'approved' || status === 'rejected')
			: [];
	} catch {
		return [];
	}
}

function parseHunkSessionIds(value: unknown): string[][] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}

	return value
		.map((entry) => (Array.isArray(entry) ? entry.filter((sessionId): sessionId is string => typeof sessionId === 'string') : []))
		.filter((entry) => entry.length > 0);
}

function stringify(value: unknown): string {
	return JSON.stringify(value);
}

function hashString(input = ''): string {
	let hash = 2_166_136_261;
	for (const character of input) {
		hash ^= character.codePointAt(0) ?? 0;
		hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
	}
	return (hash >>> 0).toString(16);
}

function buildDiffSignature(change: Pick<PendingFileChange, 'action' | 'beforeContent' | 'afterContent'>): string {
	return `${change.action}:${hashString(change.beforeContent)}:${hashString(change.afterContent)}`;
}

function buildInitialHunkStatuses(change: Pick<PendingFileChange, 'action' | 'beforeContent' | 'afterContent'>): ReviewHunkStatus[] {
	if (change.action === 'move') {
		return [];
	}
	const beforeContent = change.beforeContent ?? '';
	const afterContent = change.afterContent ?? '';
	const groups = groupHunksIntoChanges(computeDiffHunks(beforeContent, afterContent));
	return groups.map(() => 'pending');
}

function areSamePendingChange(left: PendingFileChange | undefined, right: PendingFileChange | undefined): boolean {
	if (!left || !right) {
		return left === right;
	}
	return (
		left.path === right.path &&
		left.action === right.action &&
		left.beforeContent === right.beforeContent &&
		left.afterContent === right.afterContent &&
		left.snapshotId === right.snapshotId
	);
}

function parsePendingAction(value: string): SharedReviewEntry['action'] {
	if (value === 'create' || value === 'edit' || value === 'delete' || value === 'move') {
		return value;
	}
	return 'edit';
}

function toReviewEntry(row: typeof reviewEntries.$inferSelect, hunkSessionIds?: string[][]): SharedReviewEntry {
	return {
		id: row.id,
		path: row.path,
		action: parsePendingAction(row.action),
		beforeContent: row.beforeContent ?? undefined,
		afterContent: row.afterContent ?? undefined,
		snapshotId: row.snapshotId ?? undefined,
		status: 'pending',
		hunkStatuses: parseHunkStatuses(row.hunkStatuses),
		hunkSessionIds,
		latestSessionId: row.latestSessionId,
		sessionIds: parseStringArray(row.sessionIds),
		diffSignature: row.diffSignature,
		updatedAt: row.updatedAt,
	};
}

function buildReviewSummary(entries: SharedReviewEntry[], reviewVersion: number): ReviewSummary {
	const sessionCounts: Record<string, number> = {};
	for (const entry of entries) {
		for (const sessionId of entry.sessionIds) {
			sessionCounts[sessionId] = (sessionCounts[sessionId] ?? 0) + 1;
		}
	}
	return {
		unresolvedCount: entries.length,
		reviewVersion,
		sessionCounts,
	};
}

function buildFallbackHunkSessionIds(entry: SharedReviewEntry): string[][] | undefined {
	if (entry.action === 'move') {
		return [];
	}
	const beforeContent = entry.beforeContent ?? '';
	const afterContent = entry.afterContent ?? '';
	const groupCount = groupHunksIntoChanges(computeDiffHunks(beforeContent, afterContent)).length;
	return groupCount > 0 ? Array.from({ length: groupCount }, () => [entry.latestSessionId]) : [];
}

function buildReviewEntryHunkSessionIds(
	entry: SharedReviewEntry,
	sourceRows: ReviewEntrySourceRow[],
	changeSetFilesByKey: Map<string, ChangeSetFileRow>,
): string[][] | undefined {
	if (entry.action === 'move') {
		return [];
	}

	const steps = sourceRows
		.toSorted((left, right) => left.orderIndex - right.orderIndex)
		.map((sourceRow) => changeSetFilesByKey.get(`${sourceRow.changeSetId}:${entry.path}`))
		.filter((row): row is ChangeSetFileRow => row !== undefined)
		.map((row) => ({
			afterContent: row.action === 'delete' ? '' : (row.afterContent ?? ''),
			sessionId: row.sessionId,
		}));

	if (steps.length === 0) {
		return buildFallbackHunkSessionIds(entry);
	}

	return computeDiffHunkSessionIds(entry.beforeContent ?? '', entry.afterContent ?? '', steps, entry.latestSessionId);
}

function derivePendingChangeFromWorkspace(change: PendingFileChange, currentContent: string | undefined): PendingFileChange | undefined {
	if (currentContent === undefined) {
		if (change.beforeContent === undefined) {
			return undefined;
		}
		return {
			...change,
			action: 'delete',
			afterContent: undefined,
		};
	}

	if (change.beforeContent !== undefined && change.beforeContent === currentContent) {
		return undefined;
	}

	return {
		...change,
		action: change.beforeContent === undefined ? 'create' : 'edit',
		afterContent: currentContent,
	};
}

function resolveDecisionFromHunks(hunkStatuses: SharedReviewHunkStatus[]): ReviewResolutionDecision {
	if (hunkStatuses.length === 0) {
		return 'accept';
	}
	if (hunkStatuses.every((status) => status === 'approved')) {
		return 'accept';
	}
	if (hunkStatuses.every((status) => status === 'rejected')) {
		return 'reject';
	}
	return 'mixed';
}

export {
	areSamePendingChange,
	buildDiffSignature,
	buildInitialHunkStatuses,
	buildReviewEntryHunkSessionIds,
	buildReviewSummary,
	derivePendingChangeFromWorkspace,
	parsePendingChangesRecord,
	resolveDecisionFromHunks,
	stringify,
	toReviewEntry,
};
