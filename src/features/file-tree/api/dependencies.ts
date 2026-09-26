import { createApiClient } from '../../../lib/api/create-client';

export async function fetchDependencies(projectId: string): Promise<Record<string, string>> {
	const api = createApiClient(projectId);
	const response = await api.dependencies.$get({});
	if (!response.ok) {
		throw new Error('Failed to fetch dependencies');
	}
	const data = await response.json();
	return data.dependencies;
}
export async function updateDependencies(projectId: string, dependencies: Record<string, string>): Promise<Record<string, string>> {
	const api = createApiClient(projectId);
	const response = await api.dependencies.$put({ json: { dependencies } });
	if (!response.ok) {
		throw new Error('Failed to update dependencies');
	}
	const data = await response.json();
	return data.dependencies;
}
