import { env } from 'cloudflare:workers';
import { eq, inArray, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as authSchema from '../../db/auth-schema';
import { filesystemNamespace } from '../../lib/durable-object-namespaces';
import { deleteArtifactsRepo } from '../artifacts-repo';

export const PROJECT_DELETED_VIA_PROJECT = 'project';

async function destroyProjectStorage(durableObjectHexId: string): Promise<void> {
	const filesystemId = filesystemNamespace.idFromString(durableObjectHexId);
	const filesystemStub = filesystemNamespace.get(filesystemId);
	await filesystemStub.destroyStorage();
}

async function deleteProjectRowsByIds(database: ReturnType<typeof drizzle>, projectIds: string[]): Promise<void> {
	if (projectIds.length === 0) {
		return;
	}

	await database.batch([
		database.delete(authSchema.userProjectAccess).where(inArray(authSchema.userProjectAccess.projectId, projectIds)),
		database.delete(authSchema.userProjectFavorite).where(inArray(authSchema.userProjectFavorite.projectId, projectIds)),
		database.delete(authSchema.projectTransfer).where(inArray(authSchema.projectTransfer.projectId, projectIds)),
		database.delete(authSchema.project).where(inArray(authSchema.project.id, projectIds)),
	]);
}

export async function hardDeleteProjectById(
	database: ReturnType<typeof drizzle>,
	project: { id: string; durableObjectHexId: string },
): Promise<boolean> {
	try {
		await destroyProjectStorage(project.durableObjectHexId);
	} catch (error) {
		console.warn(`Failed to delete DO for project ${project.id}:`, error);
		return false;
	}

	await deleteProjectRowsByIds(database, [project.id]);
	await deleteArtifactsRepo(env, project.id).catch((error) => {
		console.warn(`Failed to delete Artifacts repo for project ${project.id}:`, error);
		return false;
	});

	return true;
}

export async function hardDeleteOrganizationById(database: ReturnType<typeof drizzle>, organizationId: string): Promise<boolean> {
	const projectRows = await database
		.select({ id: authSchema.project.id, durableObjectHexId: authSchema.project.durableObjectHexId })
		.from(authSchema.project)
		.where(eq(authSchema.project.organizationId, organizationId));

	for (const project of projectRows) {
		try {
			await destroyProjectStorage(project.durableObjectHexId);
		} catch (error) {
			console.warn(`Failed to delete DO for project ${project.id}:`, error);
			return false;
		}
		await deleteArtifactsRepo(env, project.id).catch((error) => {
			console.warn(`Failed to delete Artifacts repo for project ${project.id}:`, error);
			return false;
		});
	}

	await deleteProjectRowsByIds(
		database,
		projectRows.map((project) => project.id),
	);

	await database.batch([
		database
			.delete(authSchema.projectTransfer)
			.where(
				or(
					eq(authSchema.projectTransfer.sourceOrganizationId, organizationId),
					eq(authSchema.projectTransfer.targetOrganizationId, organizationId),
				),
			),
		database.delete(authSchema.billingEvent).where(eq(authSchema.billingEvent.organizationId, organizationId)),
		database.delete(authSchema.entitlement).where(eq(authSchema.entitlement.scopeId, organizationId)),
		database
			.update(authSchema.session)
			// eslint-disable-next-line unicorn/no-null -- D1 requires null to clear nullable columns
			.set({ activeOrganizationId: null, updatedAt: new Date() })
			.where(eq(authSchema.session.activeOrganizationId, organizationId)),
		database.delete(authSchema.organization).where(eq(authSchema.organization.id, organizationId)),
	]);

	return true;
}
