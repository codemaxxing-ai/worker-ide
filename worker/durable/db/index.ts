export { getDatabase } from './client';
export type { AgentDatabase } from './client';

export {
	deletePendingChanges,
	deleteSessionMetadata,
	readPendingChangesData,
	readSessionMessageMetadata,
	readSessionMetadata,
	replaceSessionMessageMetadata,
	updateSessionMetadataTitleGenerated,
	upsertSessionMetadata,
	writePendingChangesData,
} from './dal';

export type {
	PendingChangesRow,
	SessionMessageMetadataInsert,
	SessionMessageMetadataRow,
	SessionMetadataInsert,
	SessionMetadataRow,
} from './schema';
