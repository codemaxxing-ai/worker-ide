import { createUserApiClient } from '../../../lib/api/create-client';
import { throwApiError } from '../../../lib/api-error';

import type { UserPreferences } from '@shared/constants';

export interface UserLimits {
	maxFreeOrganizations: number;
	currentFreeOrganizations: number;
}

export async function fetchUserLimits(): Promise<UserLimits> {
	const userApi = createUserApiClient();
	const response = await userApi.user.limits.$get({});
	if (!response.ok) {
		await throwApiError(response, 'Failed to fetch user limits');
	}
	return response.json();
}
export async function fetchUserPreferences(): Promise<UserPreferences> {
	const userApi = createUserApiClient();
	const response = await userApi.user.preferences.$get({});
	if (!response.ok) {
		await throwApiError(response, 'Failed to fetch user preferences');
	}
	return response.json();
}
export async function updateUserPreferences(preferences: Record<string, string>): Promise<void> {
	const userApi = createUserApiClient();
	const response = await userApi.user.preferences.$put({ json: preferences });
	if (!response.ok) {
		await throwApiError(response, 'Failed to save user preferences');
	}
}
export interface AccountDeletePreview {
	canDelete: boolean;
	blockers: Array<{ id: string; name: string; memberCount: number }>;
	singleMemberOrganizations: Array<{ id: string; name: string; projectCount: number }>;
	membershipOrganizations: Array<{ id: string; name: string }>;
}
export async function fetchAccountDeletePreview(): Promise<AccountDeletePreview> {
	const userApi = createUserApiClient();
	const response = await userApi.user.account['delete-preview'].$get({});
	if (!response.ok) {
		await throwApiError(response, 'Failed to fetch account deletion preview');
	}
	return response.json();
}
export async function deleteAccount(): Promise<void> {
	const userApi = createUserApiClient();
	const response = await userApi.user.account.$delete({});
	if (!response.ok) {
		await throwApiError(response, 'Failed to delete account');
	}
}
