import { createApiClient } from '../../../lib/api/create-client';
import { throwApiError } from '../../../lib/api-error';

export async function downloadDebugLog(projectId: string, logId: string, sessionId?: string): Promise<void> {
	const response = await createApiClient(projectId).agent['debug-log'].$get({ query: { id: logId, sessionId } });
	if (!response.ok) {
		await throwApiError(response, 'Failed to download debug log');
	}
	const data: unknown = await response.json();
	const blob = new Blob([JSON.stringify(data, undefined, 2)], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = `agent-debug-log-${logId}.json`;
	document.body.append(anchor);
	anchor.click();
	anchor.remove();
	URL.revokeObjectURL(url);
}
