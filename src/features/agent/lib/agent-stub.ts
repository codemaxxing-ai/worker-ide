import type { AgentRunnerClient } from '@shared/agent-rpc';
import type { AgentStub } from 'agents/client';

export type AgentRunnerStub = AgentStub<AgentRunnerClient>;

async function unavailableAgentRpc(): Promise<never> {
	throw new Error('The Agent RPC stub is unavailable.');
}

export function createUnavailableAgentRunnerStub(): AgentRunnerStub {
	return {
		submitMessage: unavailableAgentRpc,
		removeQueuedMessage: unavailableAgentRpc,
		startRun: unavailableAgentRpc,
		abortRun: unavailableAgentRpc,
		loadSession: unavailableAgentRpc,
		readSession: unavailableAgentRpc,
		listSessions: unavailableAgentRpc,
		searchSessions: unavailableAgentRpc,
		revertSession: unavailableAgentRpc,
		renameSession: unavailableAgentRpc,
		deleteSession: unavailableAgentRpc,
		loadPendingChanges: unavailableAgentRpc,
		savePendingChanges: unavailableAgentRpc,
		listReviewEntries: unavailableAgentRpc,
		updateReviewHunks: unavailableAgentRpc,
		resolveReviewEntry: unavailableAgentRpc,
		resolveReviewEntries: unavailableAgentRpc,
		syncReviewPathFromWorkspace: unavailableAgentRpc,
		moveTrackedReviewPath: unavailableAgentRpc,
		clearCurrentSession: unavailableAgentRpc,
		getRunningSessionIds: unavailableAgentRpc,
	};
}
