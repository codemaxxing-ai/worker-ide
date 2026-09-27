import { eq } from 'drizzle-orm';

import * as authSchema from '../../db/auth-schema';

import type { ProjectDatabase } from './project-access';

async function registerProject(
	database: ProjectDatabase,
	project: { id: string; organizationId: string; durableObjectId: DurableObjectId; name: string },
): Promise<void> {
	const now = new Date();
	await database.insert(authSchema.project).values({
		id: project.id,
		organizationId: project.organizationId,
		durableObjectHexId: project.durableObjectId.toString(),
		name: project.name,
		previewVisibility: 'public',
		createdAt: now,
		updatedAt: now,
		lastActivityAt: now,
	});
}

async function loadCommitAuthor(database: ProjectDatabase, userId: string): Promise<{ name: string; email: string }> {
	const userRow = await database
		.select({ name: authSchema.user.name, email: authSchema.user.email })
		.from(authSchema.user)
		.where(eq(authSchema.user.id, userId))
		.limit(1);
	return {
		name: userRow[0]?.name ?? 'IDE User',
		email: userRow[0]?.email ?? 'user@example.com',
	};
}

export { loadCommitAuthor, registerProject };
