import { z } from 'zod';

import { resolveReviewContent } from '@shared/review-diff';

import { restoreComputerSnapshots } from './computer-snapshots';

import type { WorkspaceLike } from './workspace-fs-adapter';
import type { ComputerReviewOptions } from '@shared/computer';

const metadataSchema = z.object({
	changes: z.array(
		z.object({
			path: z.string(),
			isBinary: z.boolean().optional(),
			entryType: z.string().optional(),
			beforeEntryType: z.string().optional(),
		}),
	),
});

/** Read, resolve and restore within the same execution/mutation ownership. */
export async function resolveComputerReview(workspace: WorkspaceLike, options: ComputerReviewOptions): Promise<boolean> {
	const { entry, hunkStatuses, finalizing, liveContent, decision } = options;
	if (entry.action === 'move') return false;
	const raw = entry.snapshotId ? await workspace.readFile(`/.agent/snapshots/${entry.snapshotId}/metadata.json`) : undefined;
	const saved =
		typeof raw === 'string' ? metadataSchema.parse(JSON.parse(raw)).changes.find((change) => change.path === entry.path) : undefined;
	const special =
		saved?.isBinary ||
		['symlink', 'directory'].includes(saved?.entryType ?? '') ||
		['symlink', 'directory'].includes(saved?.beforeEntryType ?? '');
	if (special) {
		const rejected = decision === 'reject' || (hunkStatuses.length > 0 && hunkStatuses.every((status) => status === 'rejected'));
		if (!finalizing || !rejected || !entry.snapshotId) return false;
		const result = await restoreComputerSnapshots(workspace, [{ snapshotId: entry.snapshotId, path: entry.path }]);
		if (result.failed.length > 0 || result.reverted.length === 0)
			throw new Error(result.failed[0]?.error ?? 'Cannot restore snapshot entry');
		return true;
	}
	if (entry.beforeContent === undefined && entry.afterContent === undefined) return false;
	const workspaceContent = await workspace.readFile(entry.path);
	const current = liveContent ?? workspaceContent ?? undefined;
	const resolution = resolveReviewContent({
		action: entry.action,
		beforeContent: entry.beforeContent,
		agentAfterContent: entry.afterContent,
		liveContent: current,
		hunkStatuses,
		finalizing,
	});
	await (resolution.action === 'delete'
		? workspace.rm(entry.path, { recursive: true, force: true })
		: workspace.writeFile(entry.path, resolution.content));
	return true;
}
