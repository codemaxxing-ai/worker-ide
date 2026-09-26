import { createApiClient, createCloudflareApiClient } from '../../../lib/api/create-client';
import { throwApiError } from '../../../lib/api-error';

import type { CloudflareAccount, CloudflareConnectionStatus, DeployStartResponse, DeployStatusResponse } from '@shared/deploy-types';

export type DeployRequest = { mode: 'permanent'; accountId: string; workerName?: string } | { mode: 'temporary'; workerName?: string };

export async function startDeployProject(projectId: string, request: DeployRequest): Promise<DeployStartResponse> {
	const api = createApiClient(projectId);
	const response = await api.deploy.$post({ json: request });
	if (!response.ok) {
		await throwApiError(response, 'Failed to deploy project');
	}
	return response.json();
}

/** URL that begins the Cloudflare OAuth connect flow (opened in a popup). */
export const CLOUDFLARE_CONNECT_URL = '/api/cloudflare/oauth/connect';

export async function getCloudflareConnection(): Promise<CloudflareConnectionStatus> {
	const api = createCloudflareApiClient();
	const response = await api.cloudflare.connection.$get({});
	if (!response.ok) {
		await throwApiError(response, 'Failed to check Cloudflare connection');
	}
	return response.json();
}

export async function listCloudflareAccounts(): Promise<CloudflareAccount[]> {
	const api = createCloudflareApiClient();
	const response = await api.cloudflare.accounts.$get({});
	if (!response.ok) {
		await throwApiError(response, 'Failed to list Cloudflare accounts');
	}
	const data = await response.json();
	return data.accounts;
}

export async function disconnectCloudflare(): Promise<void> {
	const api = createCloudflareApiClient();
	const response = await api.cloudflare.disconnect.$post({});
	if (!response.ok) {
		await throwApiError(response, 'Failed to disconnect Cloudflare account');
	}
}

export async function getDeployStatus(projectId: string, instanceId: string): Promise<DeployStatusResponse> {
	const api = createApiClient(projectId);
	const response = await api.deploy.status.$get({ query: { instanceId } });
	if (!response.ok) {
		await throwApiError(response, 'Failed to get deployment status');
	}
	return response.json();
}
