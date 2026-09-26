import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { fetchFileContent, FILE_CONTENT_GC_TIME, FILE_CONTENT_STALE_TIME } from '@/features/editor/hooks/use-file-content';
import { createApiClient } from '@/lib/api-client';
import { throwApiError } from '@/lib/api-error';
import { loadEditorSession } from '@/lib/editor-session';

import type { FileInfo } from '@shared/types';

const MAX_PREFETCHED_FILES = 8;

async function fetchFileTree(projectId: string): Promise<FileInfo[]> {
	const api = createApiClient(projectId);
	const response = await api.files.$get({});
	if (!response.ok) {
		await throwApiError(response, 'Failed to load files');
	}
	const data: { files: FileInfo[] } = await response.json();
	return data.files;
}

function buildPrefetchPaths(projectId: string): string[] {
	const session = loadEditorSession(projectId);
	if (!session) return [];

	const paths: string[] = [];
	if (session.activeFile) {
		paths.push(session.activeFile);
	}

	for (const filePath of session.openFiles) {
		if (!paths.includes(filePath)) {
			paths.push(filePath);
		}
		if (paths.length >= MAX_PREFETCHED_FILES) {
			break;
		}
	}

	return paths;
}

export function useProjectDataPrefetch(projectId: string): void {
	const queryClient = useQueryClient();

	useEffect(() => {
		let cancelled = false;
		const paths = buildPrefetchPaths(projectId);

		void queryClient.prefetchQuery({
			queryKey: ['files', projectId],
			queryFn: () => fetchFileTree(projectId),
			staleTime: 1000 * 30,
		});

		const prefetchPath = async (filePath: string) => {
			if (cancelled) return;
			await queryClient.prefetchQuery({
				queryKey: ['file', projectId, filePath],
				queryFn: () => fetchFileContent(projectId, filePath),
				staleTime: FILE_CONTENT_STALE_TIME,
				gcTime: FILE_CONTENT_GC_TIME,
			});
		};

		void (async () => {
			const [activePath, ...remainingPaths] = paths;
			if (activePath) {
				await prefetchPath(activePath);
			}

			setTimeout(() => {
				void (async () => {
					for (const filePath of remainingPaths) {
						await prefetchPath(filePath);
					}
				})();
			}, 0);
		})();

		return () => {
			cancelled = true;
		};
	}, [projectId, queryClient]);
}
