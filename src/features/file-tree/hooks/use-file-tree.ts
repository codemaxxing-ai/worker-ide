import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { toast } from '@/components/ui/toast-store';
import { createApiClient } from '@/lib/api-client';
import { throwApiError } from '@/lib/api-error';
import { useStore } from '@/lib/store';

import type { FileInfo } from '@shared/types';

interface UseFileTreeOptions {
	projectId: string;
	enabled?: boolean;
}

/**
 * Hook for loading and managing the file tree.
 * Syncs with global store for UI state (selection, expansion).
 */
export function useFileTree({ projectId, enabled = true }: UseFileTreeOptions) {
	const queryClient = useQueryClient();
	const api = createApiClient(projectId);

	// Store state
	const {
		setFiles,
		toggleDirectory,
		openFile,
		setLoading,
		files,
		activeFile,
		expandedDirs: expandedDirectories,
	} = useStore(
		useShallow((state) => ({
			setFiles: state.setFiles,
			toggleDirectory: state.toggleDirectory,
			openFile: state.openFile,
			setLoading: state.setLoading,
			files: state.files,
			activeFile: state.activeFile,
			expandedDirs: state.expandedDirs,
		})),
	);

	// Query for fetching files
	const query = useQuery({
		queryKey: ['files', projectId],
		queryFn: async () => {
			const response = await api.files.$get({});

			if (!response.ok) {
				await throwApiError(response, 'Failed to load files');
			}

			const data: { files: FileInfo[] } = await response.json();
			return data.files;
		},
		enabled,
		staleTime: 1000 * 30, // 30 seconds
	});

	// Sync query data with store
	useEffect(() => {
		if (query.data) {
			setFiles(query.data, projectId);
		}
		setLoading(query.isLoading);
	}, [projectId, query.data, query.isLoading, setFiles, setLoading]);

	// Mutation for creating files
	const createFileMutation = useMutation({
		mutationFn: async ({ path, content = '' }: { path: string; content?: string }) => {
			const response = await api.file.$put({
				json: { path, content },
			});

			if (!response.ok) {
				await throwApiError(response, 'Failed to create file');
			}

			return response.json();
		},
		onMutate: async (variables) => {
			await queryClient.cancelQueries({ queryKey: ['files', projectId] });
			const previous = queryClient.getQueryData<FileInfo[]>(['files', projectId]);
			if (previous) {
				queryClient.setQueryData<FileInfo[]>(
					['files', projectId],
					[...previous, { path: variables.path, name: variables.path.split('/').pop() ?? '', isDirectory: false }],
				);
			}
			openFile(variables.path);
			return { previous };
		},
		onError: (_error, _variables, context) => {
			if (context?.previous) {
				queryClient.setQueryData(['files', projectId], context.previous);
			}
			toast.error('Failed to create file');
		},
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey: ['files', projectId] });
		},
	});

	// Mutation for deleting files (uses query parameter, not JSON body)
	const deleteFileMutation = useMutation({
		mutationFn: async (path: string) => {
			const response = await api.file.$delete({
				query: { path },
			});

			if (!response.ok) {
				await throwApiError(response, 'Failed to delete file');
			}

			return response.json();
		},
		onMutate: async (path) => {
			await queryClient.cancelQueries({ queryKey: ['files', projectId] });
			const previous = queryClient.getQueryData<FileInfo[]>(['files', projectId]);
			if (previous) {
				queryClient.setQueryData<FileInfo[]>(
					['files', projectId],
					previous.filter((f) => f.path !== path && !f.path.startsWith(path + '/')),
				);
			}
			return { previous };
		},
		onError: (_error, _path, context) => {
			if (context?.previous) {
				queryClient.setQueryData(['files', projectId], context.previous);
			}
			toast.error('Failed to delete file');
		},
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey: ['files', projectId] });
		},
	});

	// Mutation for renaming/moving files
	const renameFileMutation = useMutation({
		mutationFn: async ({ fromPath, toPath }: { fromPath: string; toPath: string }) => {
			const response = await api.file.$patch({
				json: { from_path: fromPath, to_path: toPath },
			});

			if (!response.ok) {
				await throwApiError(response, 'Failed to rename file');
			}

			return response.json();
		},
		onMutate: async (variables) => {
			await queryClient.cancelQueries({ queryKey: ['files', projectId] });
			const previous = queryClient.getQueryData<FileInfo[]>(['files', projectId]);
			if (previous) {
				queryClient.setQueryData<FileInfo[]>(
					['files', projectId],
					previous.map((f) => {
						if (f.path === variables.fromPath) {
							return { ...f, path: variables.toPath, name: variables.toPath.split('/').pop() ?? '' };
						}
						if (f.path.startsWith(variables.fromPath + '/')) {
							return { ...f, path: f.path.replace(variables.fromPath, variables.toPath) };
						}
						return f;
					}),
				);
			}
			// If the renamed file was open, re-open it under its new path so the
			// editor tab and tree selection follow the rename.
			if (activeFile === variables.fromPath) {
				openFile(variables.toPath);
			}
			return { previous };
		},
		onError: (_error, _variables, context) => {
			if (context?.previous) {
				queryClient.setQueryData(['files', projectId], context.previous);
			}
			toast.error('Failed to rename file');
		},
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey: ['files', projectId] });
		},
	});

	// Mutation for creating directories
	const createFolderMutation = useMutation({
		mutationFn: async (path: string) => {
			const response = await api.mkdir.$post({
				json: { path },
			});

			if (!response.ok) {
				await throwApiError(response, 'Failed to create folder');
			}

			return response.json();
		},
		onMutate: async (path) => {
			await queryClient.cancelQueries({ queryKey: ['files', projectId] });
			const previous = queryClient.getQueryData<FileInfo[]>(['files', projectId]);
			if (previous) {
				queryClient.setQueryData<FileInfo[]>(
					['files', projectId],
					[...previous, { path, name: path.split('/').pop() ?? '', isDirectory: true }],
				);
			}
			return { previous };
		},
		onError: (_error, _path, context) => {
			if (context?.previous) {
				queryClient.setQueryData(['files', projectId], context.previous);
			}
			toast.error('Failed to create folder');
		},
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey: ['files', projectId] });
		},
	});

	// Select a file and open it in the editor. The active file is the single
	// source of truth for both the editor and the tree selection.
	const selectFile = (path: string) => {
		openFile(path);
	};

	return {
		// State
		files,
		selectedFile: activeFile,
		expandedDirectories,
		isLoading: query.isLoading,
		isError: query.isError,
		error: query.error ?? undefined,

		// Actions
		selectFile,
		toggleDirectory,
		refetch: async () => {
			await query.refetch();
		},

		// Mutations
		createFile: createFileMutation.mutate,
		deleteFile: deleteFileMutation.mutate,
		renameFile: renameFileMutation.mutate,
		createFolder: createFolderMutation.mutate,
		isCreating: createFileMutation.isPending,
		isDeleting: deleteFileMutation.isPending,
		isRenaming: renameFileMutation.isPending,
		isCreatingFolder: createFolderMutation.isPending,
	};
}
