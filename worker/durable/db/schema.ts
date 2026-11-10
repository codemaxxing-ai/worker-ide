import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const sessionPendingChanges = sqliteTable('session_pending_changes', {
	sessionId: text('session_id').primaryKey(),
	data: text('data').notNull().default('{}'),
});

export const sessionPendingChangeIndex = sqliteTable(
	'session_pending_change_index',
	{
		sessionId: text('session_id').notNull(),
		path: text('path').notNull(),
		updatedAt: integer('updated_at').notNull(),
		latestChangeSetId: text('latest_change_set_id'),
	},
	(table) => ({
		primaryKey: primaryKey({ columns: [table.sessionId, table.path] }),
	}),
);

export const changeSets = sqliteTable('change_sets', {
	id: text('id').primaryKey(),
	sessionId: text('session_id').notNull(),
	snapshotId: text('snapshot_id'),
	createdAt: integer('created_at').notNull(),
});

export const changeSetFiles = sqliteTable(
	'change_set_files',
	{
		changeSetId: text('change_set_id').notNull(),
		sessionId: text('session_id').notNull(),
		path: text('path').notNull(),
		action: text('action').notNull(),
		beforeContent: text('before_content'),
		afterContent: text('after_content'),
		snapshotId: text('snapshot_id'),
	},
	(table) => ({
		primaryKey: primaryKey({ columns: [table.changeSetId, table.path] }),
	}),
);

export const reviewEntries = sqliteTable('review_entries', {
	id: text('id').primaryKey(),
	path: text('path').notNull().unique(),
	action: text('action').notNull(),
	beforeContent: text('before_content'),
	afterContent: text('after_content'),
	snapshotId: text('snapshot_id'),
	status: text('status').notNull().default('pending'),
	hunkStatuses: text('hunk_statuses').notNull().default('[]'),
	latestSessionId: text('latest_session_id').notNull(),
	sessionIds: text('session_ids').notNull().default('[]'),
	diffSignature: text('diff_signature').notNull().default(''),
	updatedAt: integer('updated_at').notNull(),
});

export const reviewEntrySources = sqliteTable(
	'review_entry_sources',
	{
		reviewEntryId: text('review_entry_id').notNull(),
		changeSetId: text('change_set_id').notNull(),
		orderIndex: integer('order_index').notNull(),
	},
	(table) => ({
		primaryKey: primaryKey({ columns: [table.reviewEntryId, table.changeSetId] }),
	}),
);

export const reviewResolutions = sqliteTable('review_resolutions', {
	id: text('id').primaryKey(),
	reviewEntryId: text('review_entry_id').notNull(),
	decision: text('decision').notNull(),
	hunkStatuses: text('hunk_statuses').notNull().default('[]'),
	resolvedAt: integer('resolved_at').notNull(),
});

export type SessionPendingChangesRow = typeof sessionPendingChanges.$inferSelect;
export type SessionPendingChangesInsert = typeof sessionPendingChanges.$inferInsert;
export type SessionPendingChangeIndexRow = typeof sessionPendingChangeIndex.$inferSelect;
export type SessionPendingChangeIndexInsert = typeof sessionPendingChangeIndex.$inferInsert;
export type ChangeSetRow = typeof changeSets.$inferSelect;
export type ChangeSetInsert = typeof changeSets.$inferInsert;
export type ChangeSetFileRow = typeof changeSetFiles.$inferSelect;
export type ChangeSetFileInsert = typeof changeSetFiles.$inferInsert;
export type ReviewEntryRow = typeof reviewEntries.$inferSelect;
export type ReviewEntryInsert = typeof reviewEntries.$inferInsert;
export type ReviewEntrySourceRow = typeof reviewEntrySources.$inferSelect;
export type ReviewEntrySourceInsert = typeof reviewEntrySources.$inferInsert;
export type ReviewResolutionRow = typeof reviewResolutions.$inferSelect;
export type ReviewResolutionInsert = typeof reviewResolutions.$inferInsert;
