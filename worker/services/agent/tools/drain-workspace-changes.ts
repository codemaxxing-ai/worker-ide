import { Buffer } from 'node:buffer';

import { createHmrUpdateForFile } from '@shared/types';
import { coordinatorNamespace } from '@worker/lib/durable-object-namespaces';
import { isHiddenPath } from '@worker/lib/path-utilities';

import type { FileChange, SendEventFunction, ToolExecutorContext } from '../types';

/** Push HMR updates for the given paths through the project coordinator. */
async function triggerCoordinatorHmr(projectId: string, paths: string[]): Promise<void> {
	const coordinator = coordinatorNamespace.getByName(`project:${projectId}`);
	await Promise.all(paths.map((path) => coordinator.triggerUpdate(createHmrUpdateForFile(path))));
}

/** Claim immutable revisions for previews and review; finalization acknowledges each durable receipt. */
export async function drainWorkspaceChanges(
	context: ToolExecutorContext,
	sendEvent: SendEventFunction,
	queryChanges: FileChange[],
	triggerHmr: (projectId: string, paths: string[]) => Promise<void> = triggerCoordinatorHmr,
	alreadyRecordedPaths: ReadonlySet<string> = new Set<string>(),
): Promise<void> {
	// Per-session drain: only the changes this session made, each enriched with
	// before/after content (true no-ops already dropped by the DO).
	if (!context.sessionId) throw new Error('Workspace changes require an owning session');
	using changes = await context.fsStub.claimAgentChanges(
		context.sessionId,
		context.reviewSubmissionId ?? context.submissionId ?? context.sessionId,
		crypto.randomUUID(),
	);
	const seen = new Set<string>();
	const hmrPaths: string[] = [];

	for (const change of changes) {
		const path = change.path;
		if (seen.has(path)) continue;
		if (isHiddenPath(path)) continue;
		seen.add(path);

		const action = change.type === 'create' ? 'create' : change.type === 'delete' ? 'delete' : 'edit';
		const afterContent = change.afterContent;

		// The sender deduplicates identical revisions, never subsequent writes to a path.
		sendEvent('file_changed', {
			path,
			action,
			beforeContent: change.beforeContent,
			afterContent,
			beforeBytes: change.beforeBytes,
			afterBytes: change.afterBytes,
			isBinary: change.isBinary,
			entryType: change.entryType,
			beforeEntryType: change.beforeEntryType,
		});

		// Skip the record only when the tool already pushed this path itself
		// The UI event and HMR still fire.
		if (!alreadyRecordedPaths.has(path)) {
			queryChanges.push({
				path,
				action,
				beforeContent: change.beforeBytes === undefined ? change.beforeContent : new Uint8Array(Buffer.from(change.beforeBytes, 'base64')),
				afterContent: change.afterBytes === undefined ? afterContent : new Uint8Array(Buffer.from(change.afterBytes, 'base64')),
				isBinary: change.isBinary ?? false,
				entryType: change.entryType,
				beforeEntryType: change.beforeEntryType,
			});
		}
		hmrPaths.push(path);
	}

	if (hmrPaths.length > 0) {
		await triggerHmr(context.projectId, hmrPaths);
	}
}
