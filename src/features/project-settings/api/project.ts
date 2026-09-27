import { createApiClient } from '../../../lib/api/create-client';
import { throwApiError } from '../../../lib/api-error';

import type { AssetSettings, BindingsConfig } from '@shared/types';

export interface ProjectPermissions {
	delete: boolean;
	updateVisibility: boolean;
}

export interface ProjectMeta {
	name: string;
	assetSettings?: AssetSettings;
	bindingsConfig?: BindingsConfig;
	organizationId: string;
	organizationSlug?: string;
	permissions: ProjectPermissions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== undefined && value !== null && !Array.isArray(value);
}

function normalizeProjectPermissions(value: unknown): ProjectPermissions {
	if (!isRecord(value)) {
		throw new TypeError('Invalid project permissions response');
	}

	const canDelete = Reflect.get(value, 'delete');
	const canUpdateVisibility = Reflect.get(value, 'updateVisibility');
	if (typeof canDelete !== 'boolean' || typeof canUpdateVisibility !== 'boolean') {
		throw new TypeError('Invalid project permissions response');
	}

	return {
		delete: canDelete,
		updateVisibility: canUpdateVisibility,
	};
}

function normalizeProjectMeta(value: unknown): ProjectMeta {
	if (!isRecord(value)) {
		throw new Error('Invalid project metadata response');
	}

	const name = Reflect.get(value, 'name');
	const organizationId = Reflect.get(value, 'organizationId');
	if (typeof name !== 'string' || typeof organizationId !== 'string') {
		throw new TypeError('Invalid project metadata response');
	}

	const organizationSlugValue = Reflect.get(value, 'organizationSlug');
	const assetSettingsValue = Reflect.get(value, 'assetSettings');
	const bindingsConfigValue = Reflect.get(value, 'bindingsConfig');
	const permissionsValue = Reflect.get(value, 'permissions');

	return {
		name,
		organizationId,
		organizationSlug: typeof organizationSlugValue === 'string' ? organizationSlugValue : undefined,
		permissions: normalizeProjectPermissions(permissionsValue),
		assetSettings: isRecord(assetSettingsValue) ? assetSettingsValue : undefined,
		bindingsConfig: isRecord(bindingsConfigValue) ? bindingsConfigValue : undefined,
	};
}
export async function fetchProjectMeta(projectId: string): Promise<ProjectMeta> {
	const api = createApiClient(projectId);
	const response = await api.project.meta.$get({});
	if (!response.ok) {
		await throwApiError(response, 'Failed to fetch project meta');
	}
	const data: unknown = await response.json();
	return normalizeProjectMeta(data);
}

export async function updateProjectMeta(
	projectId: string,
	meta: { name?: string; assetSettings?: AssetSettings; bindingsConfig?: BindingsConfig },
): Promise<ProjectMeta> {
	const api = createApiClient(projectId);
	const response = await api.project.meta.$put({ json: meta });
	if (!response.ok) {
		await throwApiError(response, 'Failed to update project meta');
	}
	const data: unknown = await response.json();
	return normalizeProjectMeta(data);
}
export async function fetchStorageUsage(projectId: string): Promise<{ usageBytes: number; quotaBytes: number; enabled: boolean }> {
	const api = createApiClient(projectId);
	const response = await api.project.storage.$get({});
	if (!response.ok) {
		throw new Error('Failed to fetch storage usage');
	}
	return response.json();
}

export async function downloadProject(projectId: string): Promise<Blob> {
	const response = await createApiClient(projectId).download.$get({});
	if (!response.ok) {
		await throwApiError(response, 'Failed to download project');
	}
	return response.blob();
}
