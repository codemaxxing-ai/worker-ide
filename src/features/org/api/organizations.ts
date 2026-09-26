import { createOrgApiClient } from '../../../lib/api/create-client';
import { throwApiError } from '../../../lib/api-error';

export async function deleteProject(organizationId: string, projectId: string): Promise<void> {
	const orgApi = createOrgApiClient();
	const response = await orgApi.org[':orgId'].project[':projectId'].$delete({ param: { orgId: organizationId, projectId } });
	if (!response.ok) {
		await throwApiError(response, 'Failed to delete project');
	}
}
export interface OrgLimits {
	maxProjects: number;
	currentProjects: number;
	maxMembers: number;
	currentMembers: number;
	maxPendingInvitations: number;
	currentPendingInvitations: number;
}

export async function fetchOrgLimits(organizationId: string): Promise<OrgLimits> {
	const orgApi = createOrgApiClient();
	const response = await orgApi.org[':orgId'].limits.$get({ param: { orgId: organizationId } });
	if (!response.ok) {
		await throwApiError(response, 'Failed to fetch organization limits');
	}
	return response.json();
}
export async function fetchOrgDetails(organizationId: string) {
	const orgApi = createOrgApiClient();
	const response = await orgApi.org[':orgId'].full.$get({ param: { orgId: organizationId } });
	if (!response.ok) {
		await throwApiError(response, 'Failed to fetch organization details');
	}
	return response.json();
}
export type OrgDetails = Awaited<ReturnType<typeof fetchOrgDetails>>;

export async function deleteOrganization(organizationId: string): Promise<void> {
	const orgApi = createOrgApiClient();
	const response = await orgApi.org[':orgId'].$delete({ param: { orgId: organizationId } });
	if (!response.ok) {
		await throwApiError(response, 'Failed to delete organization');
	}
}
