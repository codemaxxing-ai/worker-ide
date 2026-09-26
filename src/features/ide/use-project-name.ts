import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { toast } from '@/components/ui/toast-store';
import { fetchProjectMeta, updateProjectMeta } from '@/lib/api-client';

export function useProjectName({ projectId }: { projectId: string }) {
	const queryClient = useQueryClient();
	// Fetch project meta via React Query
	const metaQuery = useQuery({
		queryKey: ['project-meta', projectId],
		queryFn: () => fetchProjectMeta(projectId),
		staleTime: 1000 * 60,
	});

	const projectName = metaQuery.data?.name;
	const [isEditingName, setIsEditingName] = useState(false);

	const handleStartRename = useCallback(() => {
		setIsEditingName(true);
	}, []);

	const handleSaveRename = useCallback(
		async (value: string) => {
			const trimmed = value.trim();
			setIsEditingName(false);

			if (trimmed && trimmed !== projectName) {
				const previousMeta = queryClient.getQueryData<Awaited<ReturnType<typeof fetchProjectMeta>>>(['project-meta', projectId]);

				// Optimistically set the cache
				if (previousMeta) {
					queryClient.setQueryData(['project-meta', projectId], { ...previousMeta, name: trimmed });
				}

				try {
					const newMeta = await updateProjectMeta(projectId, { name: trimmed });
					queryClient.setQueryData(['project-meta', projectId], newMeta);
					void queryClient.invalidateQueries({ queryKey: ['org-projects'] });
				} catch {
					queryClient.setQueryData(['project-meta', projectId], previousMeta);
					toast.error('Failed to rename project');
				}
			}
		},
		[projectName, projectId, queryClient],
	);

	const handleCancelRename = useCallback(() => {
		setIsEditingName(false);
	}, []);

	return {
		projectName,
		isEditingName,
		handleStartRename,
		handleSaveRename,
		handleCancelRename,
	};
}
