import { drizzle } from 'drizzle-orm/d1';

import { HttpErrorCode } from '@shared/http-errors';
import { generateHumanId } from '@shared/human-id';

import { enforceProjectLimit, requireProjectOrganization } from './project-access';
import { loadCommitAuthor, registerProject } from './project-setup';
import { buildSeedFiles } from './seed-files';
import * as authSchema from '../../db/auth-schema';
import { trackProjectEvent } from '../../lib/analytics';
import { filesystemNamespace } from '../../lib/durable-object-namespaces';
import { httpError } from '../../lib/http-error';
import { generateProjectId } from '../../lib/project-id';
import { getTemplate } from '../../templates';

interface CreateProjectOptions {
	databaseBinding: D1Database;
	organizationId: string;
	request: Request;
	templateId: string;
	userId: string;
}

async function createProject({ databaseBinding, organizationId, request, templateId, userId }: CreateProjectOptions): Promise<{
	projectId: string;
	url: string;
	name: string;
}> {
	const projectCreateStart = Date.now();
	const template = getTemplate(templateId);
	if (!template) {
		throw httpError(HttpErrorCode.VALIDATION_ERROR, `Unknown template: ${templateId}`, undefined, { includeCode: false });
	}

	const database = drizzle(databaseBinding, { schema: authSchema });
	const plan = await requireProjectOrganization(database, organizationId, userId);
	await enforceProjectLimit(database, organizationId, plan, 'create');

	const durableObjectId = filesystemNamespace.newUniqueId();
	const projectId = generateProjectId(durableObjectId);
	const projectName = generateHumanId();

	try {
		const filesystemStub = filesystemNamespace.get(durableObjectId);
		await filesystemStub.writeFiles(buildSeedFiles(template.files, projectName));
		await registerProject(database, { id: projectId, organizationId, durableObjectId, name: projectName });
		// The local commit is part of project creation. Remote setup and push are
		// best-effort inside gitInitialCommit and reconcile on the next commit.
		await filesystemStub.gitInitialCommit(await loadCommitAuthor(database, userId));

		trackProjectEvent({
			organizationId,
			eventType: 'create',
			projectId,
			userId,
			detail: templateId,
			plan,
			durationMs: Date.now() - projectCreateStart,
			success: true,
			request,
		});
		return { projectId, url: `/p/${projectId}`, name: projectName };
	} catch (error) {
		console.error('Failed to create project:', error);
		trackProjectEvent({
			organizationId,
			eventType: 'create',
			projectId,
			userId,
			detail: templateId,
			plan,
			error: error instanceof Error ? error.message : String(error),
			durationMs: Date.now() - projectCreateStart,
			success: false,
			request,
		});
		throw error;
	}
}

export { createProject };
