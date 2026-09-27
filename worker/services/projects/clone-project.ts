import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import { HttpErrorCode } from '@shared/http-errors';
import { generateHumanId } from '@shared/human-id';

import { enforceProjectLimit, requireProjectOrganization } from './project-access';
import { loadCommitAuthor, registerProject } from './project-setup';
import { transferProjectTree } from './project-tree-transfer';
import * as authSchema from '../../db/auth-schema';
import { trackProjectEvent } from '../../lib/analytics';
import { filesystemNamespace } from '../../lib/durable-object-namespaces';
import { httpError } from '../../lib/http-error';
import { generateProjectId, toDurableObjectId } from '../../lib/project-id';

interface CloneProjectOptions {
	databaseBinding: D1Database;
	organizationId: string;
	request: Request;
	sourceProjectId: string;
	userId: string;
}

async function cloneProject({ databaseBinding, organizationId, request, sourceProjectId, userId }: CloneProjectOptions): Promise<{
	projectId: string;
	url: string;
	name: string;
}> {
	const cloneStart = Date.now();
	const database = drizzle(databaseBinding, { schema: authSchema });
	const plan = await requireProjectOrganization(database, organizationId, userId);

	let sourceId: DurableObjectId;
	try {
		sourceId = toDurableObjectId(filesystemNamespace, sourceProjectId);
	} catch {
		throw httpError(HttpErrorCode.VALIDATION_ERROR, 'Invalid source project ID.', undefined, { includeCode: false });
	}

	const sourceProjectRow = await database
		.select({
			deletedAt: authSchema.project.deletedAt,
			projectBannedAt: authSchema.project.bannedAt,
			orgBannedAt: authSchema.organization.bannedAt,
		})
		.from(authSchema.project)
		.leftJoin(authSchema.organization, eq(authSchema.project.organizationId, authSchema.organization.id))
		.where(eq(authSchema.project.id, sourceProjectId))
		.limit(1);
	if (sourceProjectRow.length === 0) {
		throw httpError(HttpErrorCode.NOT_FOUND, 'Source project not found.', undefined, { includeCode: false });
	}
	if (sourceProjectRow[0].deletedAt || sourceProjectRow[0].projectBannedAt || sourceProjectRow[0].orgBannedAt) {
		throw httpError(HttpErrorCode.FORBIDDEN, 'Forbidden', undefined, { includeCode: false });
	}

	const sourceStub = filesystemNamespace.get(sourceId);
	if (!(await sourceStub.projectExists())) {
		throw httpError(HttpErrorCode.NOT_FOUND, 'Source project not found or not initialized', undefined, { includeCode: false });
	}
	await enforceProjectLimit(database, organizationId, plan, 'clone');

	const durableObjectId = filesystemNamespace.newUniqueId();
	const projectId = generateProjectId(durableObjectId);
	const projectName = generateHumanId();

	try {
		const destinationStub = filesystemNamespace.get(durableObjectId);
		await transferProjectTree(sourceStub, destinationStub);
		await registerProject(database, { id: projectId, organizationId, durableObjectId, name: projectName });
		// As with creation, local Git must be ready when cloning returns.
		await destinationStub.gitInitialCommit(await loadCommitAuthor(database, userId));

		trackProjectEvent({
			organizationId,
			eventType: 'clone',
			projectId,
			userId,
			detail: sourceProjectId,
			plan,
			durationMs: Date.now() - cloneStart,
			success: true,
			request,
		});
		return { projectId, url: `/p/${projectId}`, name: projectName };
	} catch (error) {
		console.error('Failed to clone project:', error);
		trackProjectEvent({
			organizationId,
			eventType: 'clone',
			projectId,
			userId,
			detail: sourceProjectId,
			plan,
			error: error instanceof Error ? error.message : String(error),
			durationMs: Date.now() - cloneStart,
			success: false,
			request,
		});
		throw error;
	}
}

export { cloneProject };
