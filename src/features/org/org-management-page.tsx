import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';

import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InlineRenameField } from '@/components/ui/inline-rename-field';
import { OrganizationManagementSkeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast-store';
import { InvitationRow, InviteForm, MemberRow } from '@/features/org/org-membership';
import { deleteOrganization, fetchOrgDetails, fetchOrgLimits } from '@/lib/api-client';
import { authClient } from '@/lib/auth-client';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { MAX_ORGANIZATION_NAME_LENGTH } from '@shared/constants';

import type { OrgDetails, OrgLimits } from '@/lib/api-client';

type OrgMember = OrgDetails['members'][number];

type ConfirmAction =
	| { type: 'remove'; member: OrgMember }
	| { type: 'transfer'; member: OrgMember }
	| { type: 'promote'; member: OrgMember; targetRole: string }
	| { type: 'demote'; member: OrgMember; targetRole: string }
	| { type: 'leave' };

interface OrgManagementPageProperties {
	orgSlug: string;
	organizationId: string;
	organizations: Array<{ id: string; name: string; slug: string; logo?: string | null }>;
}

export default function OrgManagementPage({ orgSlug, organizationId, organizations }: OrgManagementPageProperties) {
	const navigate = useNavigate();
	const { data: session } = authClient.useSession();
	const { refetch: refetchOrganizations } = authClient.useListOrganizations();
	const { refetch: refetchActiveOrganization } = authClient.useActiveOrganization();

	const organizationQuery = useQuery({
		queryKey: ['org-details', organizationId],
		queryFn: () => fetchOrgDetails(organizationId),
		staleTime: 1000 * 30,
	});
	const organization = organizationQuery.data;
	const isPending = organizationQuery.isPending;

	const limitsQuery = useQuery({
		queryKey: ['org-limits', organizationId],
		queryFn: () => fetchOrgLimits(organizationId),
		staleTime: 1000 * 60,
	});
	const orgLimits: OrgLimits | undefined = limitsQuery.data;

	const [confirmAction, setConfirmAction] = useState<ConfirmAction | undefined>();
	const [isActing, setIsActing] = useState(false);
	const [isRedirectingAway, setIsRedirectingAway] = useState(false);

	const [deleteOrgOpen, setDeleteOrgOpen] = useState(false);
	const [isDeletingOrg, setIsDeletingOrg] = useState(false);

	const [isEditingName, setIsEditingName] = useState(false);
	const [isRenaming, setIsRenaming] = useState(false);
	const optimisticOrganizationName = useStore((state) => state.optimisticOrganizationNames[organizationId]);
	const setOptimisticOrganizationName = useStore((state) => state.setOptimisticOrganizationName);

	const currentUserId = session?.user.id;
	const members = organization?.members ?? [];
	const invitations = organization?.invitations ?? [];
	const pendingInvitations = invitations.filter((invitation) => invitation.status === 'pending');

	const currentMember = members.find((member) => member.userId === currentUserId);
	const isOwner = currentMember?.role === 'owner';
	const isAdminOrOwner = isOwner || currentMember?.role === 'admin';

	const queryClient = useQueryClient();
	const refreshOrganization = useCallback(() => {
		void queryClient.invalidateQueries({ queryKey: ['org-details', organizationId] });
	}, [queryClient, organizationId]);
	const refreshUserLimits = useCallback(() => {
		void queryClient.invalidateQueries({ queryKey: ['user-limits'] });
	}, [queryClient]);
	const fallbackOrganization = organizations.find((organizationEntry) => organizationEntry.id !== organizationId);
	const navigateToFallbackOrganization = useCallback(async () => {
		setIsRedirectingAway(true);

		if (!fallbackOrganization) {
			globalThis.localStorage.removeItem('lastOrgSlug');
			void navigate('/create-org', { replace: true });
			void Promise.allSettled([
				refetchOrganizations(),
				refetchActiveOrganization(),
				queryClient.invalidateQueries({ queryKey: ['user-limits'] }),
			]);
			return;
		}

		globalThis.localStorage.setItem('lastOrgSlug', fallbackOrganization.slug);
		void Promise.all([
			queryClient.resetQueries({ queryKey: ['org-projects', fallbackOrganization.id] }),
			queryClient.resetQueries({ queryKey: ['org-details', fallbackOrganization.id] }),
			queryClient.resetQueries({ queryKey: ['org-limits', fallbackOrganization.id] }),
		]);
		void navigate(`/org/${fallbackOrganization.slug}`, { replace: true });
		void Promise.allSettled([
			authClient.organization.setActive({ organizationId: fallbackOrganization.id }),
			refetchOrganizations(),
			refetchActiveOrganization(),
			queryClient.invalidateQueries({ queryKey: ['user-limits'] }),
		]);
	}, [fallbackOrganization, navigate, queryClient, refetchActiveOrganization, refetchOrganizations]);

	const handleStartRename = useCallback(() => {
		setIsEditingName(true);
	}, []);

	const handleCancelRename = useCallback(() => {
		setIsEditingName(false);
	}, []);

	const handleRename = useCallback(
		async (value: string) => {
			if (isRenaming) {
				return;
			}

			const trimmed = value.trim();
			if (!trimmed || trimmed === organization?.name) {
				setIsEditingName(false);
				return;
			}
			if (trimmed.length > MAX_ORGANIZATION_NAME_LENGTH) {
				toast.error(`Name must be ${MAX_ORGANIZATION_NAME_LENGTH} characters or fewer.`);
				return;
			}

			const previousOrganization = organization;
			const previousOptimisticOrganizationName = optimisticOrganizationName;
			setIsEditingName(false);
			setIsRenaming(true);
			setOptimisticOrganizationName(organizationId, trimmed);
			if (previousOrganization) {
				queryClient.setQueryData(['org-details', organizationId], { ...previousOrganization, name: trimmed });
			}
			try {
				const { error } = await authClient.organization.update({
					data: { name: trimmed },
					organizationId: organization?.id ?? '',
				});
				if (error) {
					setOptimisticOrganizationName(organizationId, previousOptimisticOrganizationName);
					if (previousOrganization) {
						queryClient.setQueryData(['org-details', organizationId], previousOrganization);
					}
					toast.error(error.message ?? 'Failed to rename organization');
					return;
				}
				toast.success('Organization renamed');
				refreshOrganization();
			} catch {
				setOptimisticOrganizationName(organizationId, previousOptimisticOrganizationName);
				if (previousOrganization) {
					queryClient.setQueryData(['org-details', organizationId], previousOrganization);
				}
				toast.error('Failed to rename organization');
			} finally {
				setIsRenaming(false);
			}
		},
		[isRenaming, optimisticOrganizationName, organization, organizationId, queryClient, refreshOrganization, setOptimisticOrganizationName],
	);

	const handleRemoveMember = async () => {
		if (confirmAction?.type !== 'remove') return;
		setIsActing(true);
		try {
			const { error } = await authClient.organization.removeMember({
				memberIdOrEmail: confirmAction.member.id,
				organizationId: organization?.id ?? '',
			});
			if (error) {
				toast.error(error.message ?? 'Failed to remove member');
				return;
			}
			toast.success(`${confirmAction.member.user.name} removed`);
			refreshOrganization();
			refreshUserLimits();
		} catch {
			toast.error('Failed to remove member');
		} finally {
			setIsActing(false);
			setConfirmAction(undefined);
		}
	};

	const handleTransferOwnership = async () => {
		if (confirmAction?.type !== 'transfer') return;
		setIsActing(true);
		try {
			const { error } = await authClient.organization.updateMemberRole({
				memberId: confirmAction.member.id,
				role: 'owner',
				organizationId: organization?.id ?? '',
			});
			if (error) {
				toast.error(error.message ?? 'Failed to transfer ownership');
				return;
			}
			toast.success(`Ownership transferred to ${confirmAction.member.user.name}`);
			refreshOrganization();
		} catch {
			toast.error('Failed to transfer ownership');
		} finally {
			setIsActing(false);
			setConfirmAction(undefined);
		}
	};

	const handleChangeRole = async () => {
		if (confirmAction?.type !== 'promote' && confirmAction?.type !== 'demote') return;
		setIsActing(true);
		try {
			const { error } = await authClient.organization.updateMemberRole({
				memberId: confirmAction.member.id,
				role: confirmAction.targetRole,
				organizationId: organization?.id ?? '',
			});
			if (error) {
				toast.error(error.message ?? 'Failed to change role');
				return;
			}
			const verb = confirmAction.type === 'promote' ? 'promoted' : 'demoted';
			toast.success(`${confirmAction.member.user.name} ${verb} to ${confirmAction.targetRole}`);
			refreshOrganization();
		} catch {
			toast.error('Failed to change role');
		} finally {
			setIsActing(false);
			setConfirmAction(undefined);
		}
	};

	const handleLeave = async () => {
		setIsActing(true);
		try {
			const { error } = await authClient.organization.leave({
				organizationId: organization?.id ?? '',
			});
			if (error) {
				toast.error(error.message ?? 'Failed to leave organization');
				return;
			}
			toast.success('You left the organization');
			await navigateToFallbackOrganization();
		} catch {
			toast.error('Failed to leave organization');
		} finally {
			setIsActing(false);
			setConfirmAction(undefined);
		}
	};

	const handleDeleteOrg = useCallback(async () => {
		setIsDeletingOrg(true);
		try {
			await deleteOrganization(organizationId);
			toast.success('Organization deleted');
			await navigateToFallbackOrganization();
		} catch {
			toast.error('Failed to delete organization');
		} finally {
			setIsDeletingOrg(false);
			setDeleteOrgOpen(false);
		}
	}, [navigateToFallbackOrganization, organizationId]);

	const handleCancelInvitation = useCallback(
		async (invitationId: string) => {
			try {
				const { error } = await authClient.organization.cancelInvitation({
					invitationId,
				});
				if (error) {
					toast.error(error.message ?? 'Failed to cancel invitation');
					return;
				}
				toast.success('Invitation cancelled');
				refreshOrganization();
			} catch {
				toast.error('Failed to cancel invitation');
			}
		},
		[refreshOrganization],
	);

	const handleConfirm = () => {
		if (confirmAction?.type === 'remove') void handleRemoveMember();
		if (confirmAction?.type === 'transfer') void handleTransferOwnership();
		if (confirmAction?.type === 'promote' || confirmAction?.type === 'demote') void handleChangeRole();
		if (confirmAction?.type === 'leave') void handleLeave();
	};

	if (isPending || isRedirectingAway) {
		return <OrganizationManagementSkeleton />;
	}

	if (!organization) {
		return (
			<div className="flex h-dvh items-center justify-center bg-bg-primary">
				<p className="text-text-secondary">Organization not found or you don't have access to it.</p>
			</div>
		);
	}

	const confirmDialogProperties = getConfirmDialogProperties(confirmAction, organization.name);

	return (
		<div className="flex h-dvh flex-col bg-bg-primary">
			{confirmDialogProperties && (
				<ConfirmDialog
					open={confirmAction !== undefined}
					onOpenChange={(open) => {
						if (!open && !isActing) setConfirmAction(undefined);
					}}
					title={confirmDialogProperties.title}
					description={confirmDialogProperties.description}
					confirmLabel={confirmDialogProperties.confirmLabel}
					variant={confirmDialogProperties.variant}
					onConfirm={handleConfirm}
				/>
			)}

			<PageHeader
				backTo={`/org/${orgSlug}`}
				organizationSwitcher={{
					organizations,
					currentOrganizationId: organizationId,
					currentOrganizationName: organization.name,
					getOrganizationPath: (organizationEntry) => `/org/${organizationEntry.slug}/settings`,
				}}
			/>

			<main className="flex-1 overflow-y-auto">
				<div className="mx-auto w-full max-w-lg px-6 py-12">
					<div className="mb-8 flex items-center gap-3">
						{organization.logo ? (
							<img
								src={organization.logo}
								alt={organization.name}
								className="
									size-10 shrink-0 rounded-lg border border-border object-cover
								"
							/>
						) : (
							<div
								className="
									flex size-10 shrink-0 items-center justify-center rounded-lg
									bg-bg-tertiary text-sm font-medium text-text-secondary
								"
							>
								{organization.name.charAt(0).toUpperCase()}
							</div>
						)}
						<div className="min-w-0 flex-1">
							<InlineRenameField
								isEditing={isEditingName}
								displayValue={organization.name}
								inputValue={organization.name}
								onStartEditing={handleStartRename}
								onSubmit={(value) => void handleRename(value)}
								onCancel={handleCancelRename}
								inputAriaLabel="Rename organization"
								maxLength={MAX_ORGANIZATION_NAME_LENGTH}
								disabled={isRenaming}
								className="min-h-8 w-full"
								inputClassName="
									h-8 rounded-md border border-border bg-bg-secondary/60 px-2 text-sm
									font-semibold text-text-primary transition-colors
									focus:border-accent focus:outline-none
								"
							>
								{({ displayValue, startEditing }) => (
									<div className="flex items-center gap-2">
										<h1 className="truncate text-lg font-semibold text-text-primary">{displayValue}</h1>
										{isOwner && (
											<button
												onClick={startEditing}
												title="Rename organization"
												className="
													cursor-pointer rounded-md p-1 text-text-secondary transition-colors
													hover:bg-bg-tertiary hover:text-text-primary
												"
											>
												<Pencil className="size-3.5" />
											</button>
										)}
									</div>
								)}
							</InlineRenameField>
							<p className="text-xs text-text-secondary">Organization settings</p>
							<p className="mt-0.5 font-mono text-xs text-text-secondary/50">{organization.id}</p>
						</div>
						<div className="flex shrink-0 items-center gap-2">
							{!isOwner && (
								<Button variant="outline" size="sm" onClick={() => setConfirmAction({ type: 'leave' })}>
									Leave
								</Button>
							)}
						</div>
					</div>

					<section className="mb-6">
						<h2
							className="
								mb-3 text-xs font-medium tracking-wider text-text-secondary uppercase
							"
						>
							Members ({members.length}/{orgLimits?.maxMembers ?? '...'})
						</h2>
						<div className={cn('overflow-hidden rounded-lg border border-border bg-bg-secondary/40', 'divide-y divide-border')}>
							{members.map((member) => (
								<MemberRow
									key={member.id}
									member={member}
									currentUserId={currentUserId ?? ''}
									isOwner={isOwner}
									onRemove={(memberToRemove) => setConfirmAction({ type: 'remove', member: memberToRemove })}
									onTransferOwnership={(memberToTransfer) => setConfirmAction({ type: 'transfer', member: memberToTransfer })}
									onChangeRole={(memberToUpdate, targetRole, direction) =>
										setConfirmAction({ type: direction, member: memberToUpdate, targetRole })
									}
								/>
							))}
						</div>
					</section>

					{isAdminOrOwner && (
						<section className="mb-6">
							<h2
								className="
									mb-3 text-xs font-medium tracking-wider text-text-secondary uppercase
								"
							>
								Invite member
							</h2>
							<div className="rounded-lg border border-border bg-bg-secondary/40">
								<InviteForm
									organizationId={organization.id}
									memberCount={members.length}
									pendingInvitationCount={pendingInvitations.length}
									maxMembers={orgLimits?.maxMembers ?? members.length + 1}
									maxPendingInvitations={orgLimits?.maxPendingInvitations ?? pendingInvitations.length + 1}
									onInvited={refreshOrganization}
								/>
							</div>
						</section>
					)}

					{pendingInvitations.length > 0 && (
						<section className="mb-6">
							<h2
								className="
									mb-3 text-xs font-medium tracking-wider text-text-secondary uppercase
								"
							>
								Pending invitations ({pendingInvitations.length})
							</h2>
							<div
								className={cn(`
									divide-y divide-border overflow-hidden rounded-lg border border-border
									bg-bg-secondary/40
								`)}
							>
								{pendingInvitations.map((invitation) => (
									<InvitationRow
										key={invitation.id}
										invitation={invitation}
										canCancel={isAdminOrOwner}
										onCancel={(invitationId) => void handleCancelInvitation(invitationId)}
									/>
								))}
							</div>
						</section>
					)}

					{isOwner && (
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
										<p className="text-sm font-medium text-text-primary">Delete organization</p>
										<p className="text-xs text-text-secondary">Permanently delete this organization.</p>
									</div>
									<Button variant="danger" size="sm" onClick={() => setDeleteOrgOpen(true)}>
										Delete
									</Button>
								</div>
							</div>
						</section>
					)}

					<ConfirmDialog
						open={deleteOrgOpen}
						onOpenChange={(open) => {
							if (!open && !isDeletingOrg) {
								setDeleteOrgOpen(false);
							}
						}}
						title="Delete organization"
						description={
							<>
								Deleting <strong className="text-text-primary">{organization.name}</strong> is permanent and cannot be undone. All projects
								in this organization will also be deleted.
							</>
						}
						resourceName={organization.name}
						confirmLabel="Delete"
						variant="danger"
						isConfirming={isDeletingOrg}
						onConfirm={() => void handleDeleteOrg()}
					/>
				</div>
			</main>
		</div>
	);
}

function getConfirmDialogProperties(
	confirmAction: ConfirmAction | undefined,
	organizationName: string,
): { title: string; description: React.ReactNode; confirmLabel: string; variant: 'danger' | 'warning' | 'default' } | undefined {
	if (!confirmAction) return undefined;

	switch (confirmAction.type) {
		case 'remove': {
			return {
				title: 'Remove member',
				description: (
					<>
						Are you sure you want to remove <strong className="text-text-primary">{confirmAction.member.user.name}</strong> from this
						organization?
					</>
				),
				confirmLabel: 'Remove',
				variant: 'danger',
			};
		}
		case 'transfer': {
			return {
				title: 'Transfer ownership',
				description: (
					<>
						Transfer ownership to <strong className="text-text-primary">{confirmAction.member.user.name}</strong>? You will be demoted to
						admin.
					</>
				),
				confirmLabel: 'Transfer',
				variant: 'warning',
			};
		}
		case 'promote': {
			return {
				title: 'Promote member',
				description: (
					<>
						Promote <strong className="text-text-primary">{confirmAction.member.user.name}</strong> to{' '}
						<strong className="text-text-primary">{confirmAction.targetRole}</strong>?
					</>
				),
				confirmLabel: 'Promote',
				variant: 'default',
			};
		}
		case 'demote': {
			return {
				title: 'Demote member',
				description: (
					<>
						Demote <strong className="text-text-primary">{confirmAction.member.user.name}</strong> to{' '}
						<strong className="text-text-primary">{confirmAction.targetRole}</strong>?
					</>
				),
				confirmLabel: 'Demote',
				variant: 'warning',
			};
		}
		case 'leave': {
			return {
				title: 'Leave organization',
				description: (
					<>
						Are you sure you want to leave <strong className="text-text-primary">{organizationName}</strong>? You will lose access to all
						projects in this organization.
					</>
				),
				confirmLabel: 'Leave',
				variant: 'danger',
			};
		}
	}
}
