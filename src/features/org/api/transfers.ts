import { createTransferApiClient } from '../../../lib/api/create-client';
import { throwApiError } from '../../../lib/api-error';

export interface PendingTransfer {
	id: string;
	projectId: string;
	projectName: string;
	sourceOrganizationId: string;
	sourceOrganizationName: string;
	targetOrganizationId: string;
	targetOrganizationName: string;
	createdAt: string;
}
export async function fetchPendingTransfers(): Promise<{ incoming: PendingTransfer[]; outgoing: PendingTransfer[] }> {
	const transferApi = createTransferApiClient();
	const response = await transferApi.user['pending-transfers'].$get({});
	if (!response.ok) {
		await throwApiError(response, 'Failed to fetch pending transfers');
	}
	return response.json();
}
export async function initiateProjectTransfer(
	organizationId: string,
	projectId: string,
	targetOrganizationId: string,
): Promise<{ transferId: string }> {
	const transferApi = createTransferApiClient();
	const response = await transferApi.org[':orgId'].project[':projectId'].transfer.$post({
		param: { orgId: organizationId, projectId },
		json: { targetOrganizationId },
	});
	if (!response.ok) {
		await throwApiError(response, 'Failed to initiate transfer');
	}
	return response.json();
}
export async function acceptTransfer(transferId: string): Promise<void> {
	const transferApi = createTransferApiClient();
	const response = await transferApi.transfer[':transferId'].accept.$post({ param: { transferId } });
	if (!response.ok) {
		await throwApiError(response, 'Failed to accept transfer');
	}
}
export async function rejectTransfer(transferId: string): Promise<void> {
	const transferApi = createTransferApiClient();
	const response = await transferApi.transfer[':transferId'].reject.$post({ param: { transferId } });
	if (!response.ok) {
		await throwApiError(response, 'Failed to reject transfer');
	}
}
export async function cancelTransfer(transferId: string): Promise<void> {
	const transferApi = createTransferApiClient();
	const response = await transferApi.transfer[':transferId'].cancel.$post({ param: { transferId } });
	if (!response.ok) {
		await throwApiError(response, 'Failed to cancel transfer');
	}
}
