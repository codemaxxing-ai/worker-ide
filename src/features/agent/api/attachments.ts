import { createApiClient } from '../../../lib/api/create-client';
import { throwApiError } from '../../../lib/api-error';

export interface OptimizedImage {
	url: string;
	mediaType: string;
	name?: string;
}
export async function optimizeImage(projectId: string, file: File): Promise<OptimizedImage> {
	const api = createApiClient(projectId);
	const response = await api.images.optimize.$post({ form: { file } });
	if (!response.ok) {
		await throwApiError(response, 'Failed to process image');
	}
	return response.json();
}
