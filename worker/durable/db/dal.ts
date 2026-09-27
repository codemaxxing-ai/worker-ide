import { eq } from 'drizzle-orm';

import { pendingChanges, sessionMessageMetadata, sessionMetadata } from './schema';

import type { AgentDatabase } from './client';
import type { SessionMessageMetadataInsert, SessionMessageMetadataRow, SessionMetadataInsert, SessionMetadataRow } from './schema';

/* eslint-disable unicorn/no-null -- SQL nullable columns are persisted as NULL */
function toSqlNullable<T>(value: T | undefined): T | null {
	return value ?? null;
}
/* eslint-enable unicorn/no-null */

export function readSessionMetadata(database: AgentDatabase, sessionId: string): SessionMetadataRow | undefined {
	const rows = database.select().from(sessionMetadata).where(eq(sessionMetadata.id, sessionId)).all();
	return rows[0];
}

export function upsertSessionMetadata(database: AgentDatabase, data: SessionMetadataInsert): void {
	database
		.insert(sessionMetadata)
		.values(data)
		.onConflictDoUpdate({
			target: sessionMetadata.id,
			set: {
				titleGenerated: data.titleGenerated,
				contextTokensUsed: toSqlNullable(data.contextTokensUsed),
				toolMetadata: toSqlNullable(data.toolMetadata),
				toolErrors: toSqlNullable(data.toolErrors),
				status: toSqlNullable(data.status),
				errorMessage: toSqlNullable(data.errorMessage),
				stopRequested: data.stopRequested,
			},
		})
		.run();
}

export function updateSessionMetadataTitleGenerated(database: AgentDatabase, sessionId: string, isGenerated: boolean): void {
	database
		.insert(sessionMetadata)
		.values({ id: sessionId, titleGenerated: isGenerated ? 1 : 0 })
		.onConflictDoUpdate({
			target: sessionMetadata.id,
			set: { titleGenerated: isGenerated ? 1 : 0 },
		})
		.run();
}

export function deleteSessionMetadata(database: AgentDatabase, sessionId: string): void {
	database.delete(sessionMessageMetadata).where(eq(sessionMessageMetadata.sessionId, sessionId)).run();
	database.delete(sessionMetadata).where(eq(sessionMetadata.id, sessionId)).run();
}

export function readSessionMessageMetadata(database: AgentDatabase, sessionId: string): SessionMessageMetadataRow[] {
	return database.select().from(sessionMessageMetadata).where(eq(sessionMessageMetadata.sessionId, sessionId)).all();
}

export function replaceSessionMessageMetadata(database: AgentDatabase, sessionId: string, rows: SessionMessageMetadataInsert[]): void {
	database.delete(sessionMessageMetadata).where(eq(sessionMessageMetadata.sessionId, sessionId)).run();
	if (rows.length === 0) {
		return;
	}
	database.insert(sessionMessageMetadata).values(rows).run();
}

export function readPendingChangesData(database: AgentDatabase): string {
	const rows = database.select({ data: pendingChanges.data }).from(pendingChanges).where(eq(pendingChanges.id, 1)).all();
	return rows[0]?.data ?? '{}';
}

export function writePendingChangesData(database: AgentDatabase, data: string): void {
	database
		.insert(pendingChanges)
		.values({ id: 1, data })
		.onConflictDoUpdate({
			target: pendingChanges.id,
			set: { data },
		})
		.run();
}

export function deletePendingChanges(database: AgentDatabase): void {
	database.delete(pendingChanges).where(eq(pendingChanges.id, 1)).run();
}
