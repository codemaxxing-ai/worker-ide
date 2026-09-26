import { createHmrUpdateForFile } from '@shared/types';
import { coordinatorNamespace } from '@worker/lib/durable-object-namespaces';
import { isHiddenPath } from '@worker/lib/path-utilities';
import { fs } from '@worker/lib/project-fs';
import { PROJECT_ROOT } from '@worker/lib/workspace-client';

import type { FileChange, SendEventFunction, ToolExecutorContext } from '../types';

/** Push HMR updates for the given paths through the project coordinator. */
async function triggerCoordinatorHmr(projectId: string, paths: string[]): Promise<void> {
	const coordinator = coordinatorNamespace.getByName(`project:${projectId}`);
	await Promise.all(paths.map((path) => coordinator.triggerUpdate(createHmrUpdateForFile(path))));
}

/**
 * After each sandbox run, reflect workspace writes made via `state.*`/`bash`
 * back to the UI (file-change events, preview HMR, snapshots).
 *
 * `emittedChangePaths` only suppresses a duplicate `file_changed` UI event for a
 * path a `tools.*` call already announced this turn — the change itself is
 * ALWAYS recorded into `queryChanges`. Dropping it would leave the review diff
 * stale (showing edits that are already on disk) when a later `state.writeFile`
 * mutates a path a tool already touched.
 *
 * `triggerHmr` is injectable so this can be unit-tested without the coordinator
 * Durable Object; it defaults to the real coordinator HMR push.
 *
 * `alreadyRecordedPaths` names paths a tool already pushed into `queryChanges`
 * itself. In Code Mode `tools.*` run in a separate RPC facet, so their pushes
 * never reach this array and the set is empty. In the no-loader fallback the
 * tools run in this context and DO push, so the set suppresses the duplicate
 * `queryChanges` entry while still emitting the UI event and HMR.
 */
export async function drainWorkspaceChanges(
	context: ToolExecutorContext,
	sendEvent: SendEventFunction,
	queryChanges: FileChange[],
	emittedChangePaths: ReadonlySet<string>,
	triggerHmr: (projectId: string, paths: string[]) => Promise<void> = triggerCoordinatorHmr,
	alreadyRecordedPaths: ReadonlySet<string> = new Set<string>(),
): Promise<void> {
	// Per-session drain: only the changes this session made, each enriched with
	// before/after content (true no-ops already dropped by the DO).
	using changes = await context.fsStub.drainWorkspaceChanges(context.sessionId);
	const seen = new Set<string>();
	const hmrPaths: string[] = [];

	for (const change of changes) {
		const path = change.path;
		if (seen.has(path)) continue;
		if (isHiddenPath(path)) continue;
		seen.add(path);

		const action = change.type === 'create' ? 'create' : change.type === 'delete' ? 'delete' : 'edit';
		// The DO provides after-content; fall back to a live read only when it
		// could not (e.g. an unattributed legacy drain returning no content).
		let afterContent = change.afterContent;
		if (afterContent === undefined && action !== 'delete') {
			try {
				afterContent = await fs.readFile(`${PROJECT_ROOT}${path}`, 'utf8');
			} catch {
				afterContent = undefined;
			}
		}

		// Avoid a duplicate UI event when a `tools.*` call in this same turn already
		// emitted a file_changed for this path — but ALWAYS record the change so the
		// review queue reflects the final content. A later `state.writeFile` to a
		// path a tool already touched must not be dropped (it would leave the review
		// diff stale, showing changes that are already on disk).
		if (!emittedChangePaths.has(path)) {
			sendEvent('file_changed', { path, action, beforeContent: change.beforeContent, afterContent });
		}
		// Skip the record only when the tool already pushed this path itself
		// (no-loader fallback); the UI event and HMR above still fire.
		if (!alreadyRecordedPaths.has(path)) {
			queryChanges.push({ path, action, beforeContent: change.beforeContent, afterContent, isBinary: false });
		}
		hmrPaths.push(path);
	}

	if (hmrPaths.length > 0) {
		await triggerHmr(context.projectId, hmrPaths);
	}
}
