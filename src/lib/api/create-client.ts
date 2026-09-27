import { hc } from 'hono/client';

import type { ApiRoutes, CloudflareOAuthRoutes, OrgRoutes, RootApiRoutes, TransferRoutes, UserRoutes } from '@server/routes';

export function createApiClient(projectId: string) {
	const baseUrl = `/p/${projectId}`;
	return hc<ApiRoutes>(`${baseUrl}/api`);
}
export type ApiClient = ReturnType<typeof createApiClient>;

export function createUserApiClient() {
	return hc<UserRoutes>('/api');
}
export function createOrgApiClient() {
	return hc<OrgRoutes>('/api');
}
export function createTransferApiClient() {
	return hc<TransferRoutes>('/api');
}
export function createCloudflareApiClient() {
	return hc<CloudflareOAuthRoutes>('/api');
}

export function createRootApiClient() {
	return hc<RootApiRoutes>('/api');
}
