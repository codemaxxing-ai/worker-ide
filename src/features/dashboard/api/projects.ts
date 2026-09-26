import { createRootApiClient, createOrgApiClient, createUserApiClient } from '../../../lib/api/create-client';
import { throwApiError } from '../../../lib/api-error';

import type { ProjectTemplateMeta } from '@shared/types';

export async function createProject(organizationId: string, templateId: string): Promise<{ projectId: string; url: string; name: string }> {
	const response = await createRootApiClient()['new-project'].$post({
		json: { template: templateId, organizationId },
	});
	if (!response.ok) {
		await throwApiError(response, 'Failed to create project');
	}
	const data: { projectId: string; url: string; name: string } = await response.json();
	return data;
}

export async function cloneProject(
	organizationId: string,
	sourceProjectId: string,
): Promise<{ projectId: string; url: string; name: string }> {
	const response = await createRootApiClient()['clone-project'].$post({
		json: { sourceProjectId, organizationId },
	});
	if (!response.ok) {
		await throwApiError(response, 'Failed to clone project');
	}
	const data: { projectId: string; url: string; name: string } = await response.json();
	return data;
}

export async function fetchTemplates(): Promise<ProjectTemplateMeta[]> {
	const response = await createRootApiClient().templates.$get({});
	if (!response.ok) {
		await throwApiError(response, 'Failed to fetch templates');
	}
	const data: { templates: ProjectTemplateMeta[] } = await response.json();
	return data.templates;
}

export async function fetchOrgProjects(organizationId: string) {
	const orgApi = createOrgApiClient();
	const response = await orgApi.org[':orgId'].projects.$get({ param: { orgId: organizationId } });
	if (!response.ok) {
		await throwApiError(response, 'Failed to fetch organization projects');
	}
	const data = await response.json();
	return data.projects;
}
export type OrgProject = Awaited<ReturnType<typeof fetchOrgProjects>>[number];
export interface RecentProject {
	id: string;
	organizationId: string;
	name: string;
	previewVisibility: string;
	createdAt: string;
	updatedAt: string;
	lastAccessedAt: string;
	isFavorite: boolean;
	organizationName: string;
	organizationSlug: string;
}
export async function fetchRecentProjects(): Promise<RecentProject[]> {
	const userApi = createUserApiClient();
	const response = await userApi.user['recent-projects'].$get({});
	if (!response.ok) {
		await throwApiError(response, 'Failed to fetch recent projects');
	}
	const data = await response.json();
	return data.projects;
}
export async function setProjectFavorite(projectId: string, favorite: boolean): Promise<void> {
	const userApi = createUserApiClient();
	const response = await userApi.user.project[':projectId'].favorite.$put({ param: { projectId }, json: { favorite } });
	if (!response.ok) {
		await throwApiError(response, 'Failed to update favorite');
	}
}
