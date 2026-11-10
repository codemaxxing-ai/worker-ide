import { Buffer } from 'node:buffer';

import { runWithProjectStub } from '@worker/lib/project-fs';

import { accumulatePendingChange } from './pending-changes';
import { addFileToSnapshot } from './snapshot-manager';

import type { AgentDebugLog } from './agent-logger';
import type { ProjectFilesystem } from '../../durable/project-filesystem';
import type { ChatConfiguration } from '@shared/agent-chat';
import type { PendingFileChange } from '@shared/types';

export interface PendingAgentFinalization {
	changesPrepared: boolean;
	submissionId: string;
	status: 'completed' | 'error' | 'aborted';
	initiatorUserId?: string;
	changes: Record<string, PendingFileChange>;
	snapshot?: { id: string; directory: string; savedPaths: string[] };
	debugLog?: AgentDebugLog;
}

/** Persist each immutable receipt in the agent outbox before acknowledging it at the filesystem. */
export async function finalizeAgentChanges(
	filesystem: DurableObjectStub<ProjectFilesystem>,
	configuration: ChatConfiguration,
	pending: PendingAgentFinalization,
	checkpoint: (pending: PendingAgentFinalization) => void,
): Promise<PendingAgentFinalization> {
	if (!pending.snapshot) return pending;
	await filesystem.settleAgentTurn(configuration.sessionId);
	// Include changes whose tool was cancelled before it could claim its result.
	using unobserved = await filesystem.claimAgentChanges(configuration.sessionId, pending.submissionId, crypto.randomUUID());
	void unobserved;
	const receipts = await filesystem.getAgentChangeReceiptIds(configuration.sessionId, pending.submissionId);
	let current = pending;
	for (const receiptId of receipts) {
		using revisions = await filesystem.readAgentChangeReceipt(configuration.sessionId, receiptId);
		const changes = new Map(Object.entries(current.changes));
		const snapshot = { ...pending.snapshot, savedPaths: new Set(current.snapshot?.savedPaths) };
		for (const revision of revisions) {
			const action = revision.type === 'update' ? 'edit' : revision.type;
			await runWithProjectStub(
				filesystem,
				() =>
					addFileToSnapshot(snapshot, {
						path: revision.path,
						action,
						isBinary: revision.isBinary,
						entryType: revision.entryType,
						beforeEntryType: revision.beforeEntryType,
						beforeContent:
							revision.beforeBytes === undefined ? revision.beforeContent : new Uint8Array(Buffer.from(revision.beforeBytes, 'base64')),
						afterContent:
							revision.afterBytes === undefined ? revision.afterContent : new Uint8Array(Buffer.from(revision.afterBytes, 'base64')),
					}),
				'/project',
				configuration.sessionId,
			);
			accumulatePendingChange(changes, { ...revision, action, sessionId: configuration.sessionId, snapshotId: snapshot.id });
		}
		current = {
			...current,
			changes: Object.fromEntries(changes),
			snapshot: { id: snapshot.id, directory: snapshot.directory, savedPaths: [...snapshot.savedPaths] },
		};
		checkpoint(current);
		await filesystem.acknowledgeAgentChanges(configuration.sessionId, receiptId);
	}
	return current;
}
