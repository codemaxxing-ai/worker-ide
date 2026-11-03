import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Container, Eye, EyeOff } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Modal, ModalBody, ModalFooter } from '@/components/ui/modal';
import { ModalContentSkeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast-store';
import { createApiClient, deleteProject, fetchProjectMeta, updateProjectMeta } from '@/lib/api-client';
import { throwApiError } from '@/lib/api-error';
import { invalidateProjectAccess } from '@/lib/project-access';
import { cn } from '@/lib/utils';

import type { OrgProject } from '@/lib/api-client';

interface ProjectSettingsModalProperties {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
}

type Visibility = 'public' | 'private';

async function fetchVisibility(projectId: string): Promise<Visibility> {
	const api = createApiClient(projectId);
	const response = await api.project.visibility.$get({});
	if (!response.ok) {
		await throwApiError(response, 'Failed to fetch visibility');
	}
	const data = await response.json();
	return data.visibility === 'private' ? 'private' : 'public';
}

async function updateVisibility(projectId: string, visibility: Visibility): Promise<void> {
	const api = createApiClient(projectId);
	const response = await api.project.visibility.$put({ json: { visibility } });
	if (!response.ok) {
		await throwApiError(response, 'Failed to update visibility');
	}
}

export function ProjectSettingsModal({ open, onOpenChange, projectId }: ProjectSettingsModalProperties) {
	const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

	const handleSettingsOpenChange = useCallback(
		(nextOpen: boolean) => {
			onOpenChange(nextOpen);
			if (nextOpen) {
				setDeleteConfirmOpen(false);
			}
		},
		[onOpenChange],
	);

	return (
		(open || deleteConfirmOpen) && (
			<ProjectSettingsContent
				open={open}
				onOpenChange={handleSettingsOpenChange}
				projectId={projectId}
				deleteConfirmOpen={deleteConfirmOpen}
				setDeleteConfirmOpen={setDeleteConfirmOpen}
			/>
		)
	);
}

function ProjectSettingsContent({
	open,
	onOpenChange,
	projectId,
	deleteConfirmOpen,
	setDeleteConfirmOpen,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	deleteConfirmOpen: boolean;
	setDeleteConfirmOpen: (open: boolean) => void;
}) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [isSaving, setIsSaving] = useState(false);
	const [isDeleting, setIsDeleting] = useState(false);
	const [error, setError] = useState<string | undefined>();

	const metaQuery = useQuery({
		queryKey: ['project-meta', projectId],
		queryFn: () => fetchProjectMeta(projectId),
		staleTime: 0,
	});

	const visibilityQuery = useQuery({
		queryKey: ['project-visibility', projectId],
		queryFn: () => fetchVisibility(projectId),
		staleTime: 0,
	});

	const [visibility, setVisibility] = useState<Visibility>('public');
	const [alwaysUseContainer, setAlwaysUseContainer] = useState(false);
	const [lastRuntimeSetting, setLastRuntimeSetting] = useState<boolean | undefined>();
	if (metaQuery.data && metaQuery.data.alwaysUseContainer !== lastRuntimeSetting) {
		setLastRuntimeSetting(metaQuery.data.alwaysUseContainer);
		setAlwaysUseContainer(metaQuery.data.alwaysUseContainer);
	}
	const [lastSyncedVisibility, setLastSyncedVisibility] = useState<Visibility | undefined>();

	if (visibilityQuery.data && visibilityQuery.data !== lastSyncedVisibility) {
		setLastSyncedVisibility(visibilityQuery.data);
		setVisibility(visibilityQuery.data);
	}

	const handleSave = useCallback(async () => {
		setIsSaving(true);
		setError(undefined);
		try {
			await updateVisibility(projectId, visibility);
			await updateProjectMeta(projectId, { alwaysUseContainer });
			await queryClient.invalidateQueries({ queryKey: ['project-meta', projectId] });
			onOpenChange(false);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to save settings';
			setError(message);
		} finally {
			setIsSaving(false);
		}
	}, [projectId, visibility, alwaysUseContainer, onOpenChange, queryClient]);

	const handleDelete = useCallback(async () => {
		const projectMeta = metaQuery.data;
		if (!projectMeta?.organizationId) {
			setError('Failed to load project details');
			return;
		}

		setIsDeleting(true);
		setError(undefined);
		try {
			await deleteProject(projectMeta.organizationId, projectId);
			invalidateProjectAccess(projectId);
			queryClient.removeQueries({ queryKey: ['project-meta', projectId] });
			queryClient.removeQueries({ queryKey: ['project-visibility', projectId] });
			queryClient.setQueryData<Array<OrgProject> | undefined>(['org-projects', projectMeta.organizationId], (previousProjects) =>
				previousProjects?.filter((project) => project.id !== projectId),
			);
			void queryClient.invalidateQueries({ queryKey: ['org-projects', projectMeta.organizationId] });
			void queryClient.invalidateQueries({ queryKey: ['org-limits', projectMeta.organizationId] });
			void queryClient.invalidateQueries({ queryKey: ['org-projects'] });
			void queryClient.invalidateQueries({ queryKey: ['org-limits'] });
			onOpenChange(false);
			setDeleteConfirmOpen(false);
			toast.success('Project deleted');
			void navigate(projectMeta.organizationSlug ? `/org/${projectMeta.organizationSlug}` : '/', { replace: true });
		} catch (deleteError) {
			setError(deleteError instanceof Error ? deleteError.message : 'Failed to delete project');
		} finally {
			setIsDeleting(false);
		}
	}, [metaQuery.data, navigate, onOpenChange, projectId, queryClient, setDeleteConfirmOpen]);

	return (
		<>
			<Modal open={open} onOpenChange={onOpenChange} title="Project Settings" className="w-[480px]">
				{visibilityQuery.isLoading || metaQuery.isLoading ? (
					<ModalBody className="min-h-40">
						<ModalContentSkeleton />
					</ModalBody>
				) : visibilityQuery.isError || metaQuery.isError || !metaQuery.data ? (
					<>
						<ModalBody className="flex flex-col gap-4">
							<div className="rounded-sm border border-red-500/30 bg-red-500/10 p-2.5">
								<p className="text-xs text-red-500">Failed to load project settings</p>
							</div>
						</ModalBody>
						<ModalFooter>
							<Button variant="secondary" onClick={() => onOpenChange(false)}>
								Close
							</Button>
						</ModalFooter>
					</>
				) : (
					<>
						<ModalBody className="flex flex-col gap-6">
							{error && (
								<div className="rounded-sm border border-red-500/30 bg-red-500/10 p-2.5">
									<p className="text-xs text-red-500">{error}</p>
								</div>
							)}

							<fieldset className="flex flex-col gap-2">
								<legend
									className="
										mb-3 text-xs font-medium tracking-wider text-text-secondary uppercase
									"
								>
									Preview visibility
								</legend>
								<div className="grid grid-cols-2 gap-2">
									<label
										className={cn(
											`
												flex cursor-pointer items-start gap-2.5 rounded-lg border p-3
												transition-colors
											`,
											visibility === 'public' ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/50',
										)}
										htmlFor="vis-public"
									>
										<input
											id="vis-public"
											type="radio"
											name="visibility"
											value="public"
											checked={visibility === 'public'}
											onChange={() => setVisibility('public')}
											className="mt-0.5 accent-accent"
										/>
										<div className="flex flex-col gap-0.5">
											<span
												className="
													flex items-center gap-1.5 text-xs font-medium text-text-primary
												"
											>
												<Eye className="size-3.5" />
												Public
											</span>
											<span className="text-xs text-text-secondary">Anyone with the link.</span>
										</div>
									</label>
									<label
										className={cn(
											`
												flex cursor-pointer items-start gap-2.5 rounded-lg border p-3
												transition-colors
											`,
											visibility === 'private' ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/50',
										)}
										htmlFor="vis-private"
									>
										<input
											id="vis-private"
											type="radio"
											name="visibility"
											value="private"
											checked={visibility === 'private'}
											onChange={() => setVisibility('private')}
											className="mt-0.5 accent-accent"
										/>
										<div className="flex flex-col gap-0.5">
											<span
												className="
													flex items-center gap-1.5 text-xs font-medium text-text-primary
												"
											>
												<EyeOff className="size-3.5" />
												Private
											</span>
											<span className="text-xs text-text-secondary">Organization members.</span>
										</div>
									</label>
								</div>
							</fieldset>

							<fieldset className="flex flex-col gap-2">
								<legend
									className="
										mb-3 text-xs font-medium tracking-wider text-text-secondary uppercase
									"
								>
									Runtime
								</legend>
								<div
									className="
										rounded-lg border border-border bg-bg-secondary/40 px-4 py-3
									"
								>
									<div className="flex items-center justify-between gap-4">
										<div className="flex min-w-0 items-center gap-2.5">
											<Container aria-hidden="true" className="size-4 shrink-0 text-text-secondary" />
											<label htmlFor="project-always-use-container" className="text-sm font-medium text-text-primary">
												Always use a container
											</label>
										</div>
										<input
											id="project-always-use-container"
											type="checkbox"
											role="switch"
											aria-describedby="project-runtime-description"
											checked={alwaysUseContainer}
											onChange={(event) => setAlwaysUseContainer(event.target.checked)}
											className="
												relative h-5 w-9 shrink-0 cursor-pointer appearance-none
												rounded-full bg-border transition-colors
												before:absolute before:top-0.5 before:left-0.5 before:size-4
												before:rounded-full before:bg-text-primary
												before:transition-transform
												checked:bg-accent
												checked:before:translate-x-4 checked:before:bg-bg-primary
												focus-visible:outline-2 focus-visible:outline-offset-2
												focus-visible:outline-accent
											"
										/>
									</div>
									<p id="project-runtime-description" className="mt-2 text-xs text-text-secondary">
										{alwaysUseContainer
											? 'Use a container for every preview and build.'
											: 'Worker by default. Falls back to a container when needed.'}
									</p>
								</div>
							</fieldset>

							{metaQuery.data.permissions.delete && (
								<section>
									<h2
										className="
											mb-3 text-xs font-medium tracking-wider text-error/80 uppercase
										"
									>
										Danger zone
									</h2>
									<div
										className="
											rounded-lg border border-error/30 bg-bg-secondary/40 px-4 py-3
										"
									>
										<div className="flex items-center justify-between gap-3">
											<div className="min-w-0">
												<p className="text-sm font-medium text-text-primary">Delete project</p>
												<p className="text-xs text-text-secondary">Permanently delete this project.</p>
											</div>
											<Button
												variant="danger"
												size="sm"
												disabled={isSaving || isDeleting}
												onClick={() => {
													onOpenChange(false);
													setDeleteConfirmOpen(true);
												}}
											>
												Delete
											</Button>
										</div>
									</div>
								</section>
							)}
						</ModalBody>
						<ModalFooter>
							<Button variant="secondary" onClick={() => onOpenChange(false)} disabled={isSaving || isDeleting}>
								Cancel
							</Button>
							<Button onClick={handleSave} disabled={isSaving || isDeleting} isLoading={isSaving}>
								Save
							</Button>
						</ModalFooter>
					</>
				)}
			</Modal>
			<ConfirmDialog
				open={deleteConfirmOpen}
				onOpenChange={(open) => {
					if (!open && !isDeleting) {
						setDeleteConfirmOpen(false);
					}
				}}
				title="Delete project"
				description={
					<>
						Deleting <strong className="text-text-primary">{metaQuery.data?.name}</strong> is permanent and cannot be undone.
					</>
				}
				resourceName={metaQuery.data?.name ?? ''}
				confirmLabel="Delete"
				variant="danger"
				isConfirming={isDeleting}
				onConfirm={() => void handleDelete()}
			/>
		</>
	);
}
