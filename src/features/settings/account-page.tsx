import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor, Smartphone, Trash2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';

import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Modal, ModalBody, ModalFooter } from '@/components/ui/modal';
import { ListSkeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast-store';
import {
	deleteAccount,
	fetchAccountDeletePreview,
	fetchActiveSessions,
	revokeActiveSession,
	revokeOtherActiveSessions,
} from '@/lib/api-client';
import { ApiError } from '@/lib/api-error';
import { authClient } from '@/lib/auth-client';
import { formatRelativeTime } from '@/lib/utils';

import type { AccountDeletePreview } from '@/lib/api-client';

export default function AccountPage() {
	const navigate = useNavigate();
	const { data: session } = authClient.useSession();

	const sessionsQuery = useQuery({
		queryKey: ['sessions'],
		queryFn: fetchActiveSessions,
		staleTime: 1000 * 30,
	});

	const queryClient = useQueryClient();
	const [showReauthenticationModal, setShowReauthenticationModal] = useState(false);

	const handleRevocationError = useCallback((error: unknown) => {
		if (error instanceof ApiError && error.code === 'SESSION_NOT_FRESH') {
			setShowReauthenticationModal(true);
			return;
		}

		toast.error('Could not revoke sessions. Please check your connection and try again.');
	}, []);

	const handleRevokeSession = useCallback(
		async (sessionId: string) => {
			try {
				await revokeActiveSession(sessionId);
				toast.success('Session revoked');
				void queryClient.invalidateQueries({ queryKey: ['sessions'] });
			} catch (error) {
				handleRevocationError(error);
			}
		},
		[handleRevocationError, queryClient],
	);

	const handleRevokeAllOtherSessions = useCallback(async () => {
		try {
			await revokeOtherActiveSessions();
			toast.success('All other sessions revoked');
			void queryClient.invalidateQueries({ queryKey: ['sessions'] });
		} catch (error) {
			handleRevocationError(error);
		}
	}, [handleRevocationError, queryClient]);

	const handleSignInAgain = useCallback(async () => {
		try {
			const { error } = await authClient.signOut();
			if (error) {
				toast.error(error.message ?? 'Could not sign out. Please try again.');
				return;
			}
			globalThis.location.href = '/?next=%2Fsettings%2Faccount';
		} catch {
			toast.error('Could not sign out. Please check your connection and try again.');
		}
	}, []);

	const [deletePreview, setDeletePreview] = useState<AccountDeletePreview | undefined>();
	const [isLoadingPreview, setIsLoadingPreview] = useState(false);
	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
	const [showBlockersModal, setShowBlockersModal] = useState(false);
	const [isDeleting, setIsDeleting] = useState(false);

	const handleOpenDeleteModal = useCallback(async () => {
		setIsLoadingPreview(true);
		try {
			const preview = await fetchAccountDeletePreview();
			setDeletePreview(preview);
			if (preview.canDelete) {
				setShowDeleteConfirm(true);
			} else {
				setShowBlockersModal(true);
			}
		} catch {
			toast.error('Could not load account deletion details. Please check your connection and try again.');
		} finally {
			setIsLoadingPreview(false);
		}
	}, []);

	const handleConfirmDelete = useCallback(async () => {
		setIsDeleting(true);
		try {
			await deleteAccount();
			toast.success('Account deleted');
			void navigate('/');
		} catch {
			toast.error('Could not delete your account. You may need to transfer ownership of organizations where you are the sole Super admin.');
		} finally {
			setIsDeleting(false);
			setShowDeleteConfirm(false);
		}
	}, [navigate]);

	const sessions = sessionsQuery.data ?? [];

	return (
		<div className="flex flex-col gap-8">
			<div>
				<h2 className="mb-1 text-lg font-semibold text-text-primary">Account</h2>
				<p className="text-sm text-text-secondary">Manage sessions and account settings.</p>
			</div>

			<section>
				<div className="mb-3 flex items-center justify-between">
					<h3
						className="
							text-xs font-medium tracking-wider text-text-secondary uppercase
						"
					>
						Active sessions
					</h3>
					{sessions.length > 1 && (
						<ConfirmButton
							title="Sign out all sessions?"
							confirmLabel="Sign out"
							onConfirm={handleRevokeAllOtherSessions}
							variant="outline"
							size="sm"
							confirmVariant="warning"
						>
							Sign out all others
						</ConfirmButton>
					)}
				</div>
				<div
					className="
						divide-y divide-border rounded-lg border border-border bg-bg-secondary/40
					"
				>
					{sessionsQuery.isPending ? (
						<div className="p-3">
							<ListSkeleton itemCount={3} />
						</div>
					) : sessionsQuery.isError ? (
						<div className="px-4 py-6 text-center text-sm text-text-secondary">
							Could not load sessions.{' '}
							<button onClick={() => void sessionsQuery.refetch()} className="cursor-pointer text-accent underline hover:text-accent-hover">
								Retry
							</button>
						</div>
					) : sessions.length === 0 ? (
						<div className="px-4 py-6 text-center text-sm text-text-secondary">No active sessions found.</div>
					) : (
						sessions.map((session) => {
							const isMobile = session.userAgent?.includes('Mobile') ?? false;
							const Icon = isMobile ? Smartphone : Monitor;
							const createdAt = new Date(session.createdAt).getTime();
							return (
								<div key={session.id} className="flex items-center justify-between gap-3 px-4 py-3">
									<div className="flex min-w-0 items-center gap-3">
										<Icon className="size-4 shrink-0 text-text-secondary" />
										<div className="min-w-0">
											<p className="truncate text-sm text-text-primary">
												{session.userAgent?.slice(0, 60) ?? 'Unknown device'}
												{session.current && <span className="ml-1.5 text-xs font-medium text-accent">(current)</span>}
											</p>
											<p className="text-xs text-text-secondary">
												{session.ipAddress ?? 'Unknown IP'} &middot; {formatRelativeTime(createdAt)}
											</p>
										</div>
									</div>
									{!session.current && (
										<ConfirmButton
											title="Revoke this session?"
											confirmLabel="Revoke"
											onConfirm={() => handleRevokeSession(session.id)}
											variant="ghost"
											size="sm"
											className="
												shrink-0 text-xs text-text-secondary
												hover:text-error
											"
										>
											Revoke
										</ConfirmButton>
									)}
								</div>
							);
						})
					)}
				</div>
			</section>

			<section>
				<h3 className="mb-3 text-xs font-medium tracking-wider text-error/80 uppercase">Danger zone</h3>
				<div className="rounded-lg border border-error/30 bg-bg-secondary/40 px-4 py-3">
					<div className="flex items-center justify-between gap-3">
						<div className="min-w-0">
							<p className="text-sm font-medium text-text-primary">Delete account</p>
							<p className="text-xs text-text-secondary">Permanently delete your account.</p>
						</div>
						<Button
							variant="danger"
							size="sm"
							onClick={() => void handleOpenDeleteModal()}
							disabled={isLoadingPreview}
							isLoading={isLoadingPreview}
						>
							<Trash2 className="size-3.5" />
							Delete
						</Button>
					</div>
				</div>
			</section>

			<ConfirmDialog
				open={showDeleteConfirm}
				onOpenChange={(open) => {
					if (!open && !isDeleting) setShowDeleteConfirm(false);
				}}
				title="Delete account"
				description={
					<>
						<p>
							Deleting <strong className="text-text-primary">{session?.user.email}</strong> is permanent and cannot be undone.
						</p>
						{deletePreview && deletePreview.singleMemberOrganizations.length > 0 && (
							<p className="mt-2 text-xs">
								<strong className="text-text-primary">{deletePreview.singleMemberOrganizations.length} organization(s)</strong> you own
								alone will also be deleted, including their projects.
							</p>
						)}
						{deletePreview && deletePreview.membershipOrganizations.length > 0 && (
							<p className="mt-1 text-xs">
								You will lose access to{' '}
								<strong className="text-text-primary">{deletePreview.membershipOrganizations.length} organization(s)</strong>.
							</p>
						)}
					</>
				}
				resourceName={session?.user.email ?? ''}
				confirmLabel="Delete"
				variant="danger"
				isConfirming={isDeleting}
				onConfirm={() => void handleConfirmDelete()}
			/>

			<Modal open={showReauthenticationModal} onOpenChange={setShowReauthenticationModal} title="Sign in again">
				<ModalBody>
					<p className="text-sm text-text-secondary">
						For your security, you need to have signed in within the last 24 hours before revoking sessions.
					</p>
				</ModalBody>
				<ModalFooter>
					<Button variant="secondary" size="sm" onClick={() => setShowReauthenticationModal(false)}>
						Cancel
					</Button>
					<Button size="sm" onClick={() => void handleSignInAgain()}>
						Sign in again
					</Button>
				</ModalFooter>
			</Modal>

			{deletePreview && !deletePreview.canDelete && (
				<Modal open={showBlockersModal} onOpenChange={setShowBlockersModal} title="Delete account">
					<ModalBody>
						<div className="flex flex-col gap-2 text-sm text-text-secondary">
							<p>You cannot delete your account yet. You are the sole Super admin of:</p>
							<ul className="list-disc pl-4">
								{deletePreview.blockers.map((blocker) => (
									<li key={blocker.id}>
										<strong className="text-text-primary">{blocker.name}</strong> ({blocker.memberCount} members)
									</li>
								))}
							</ul>
							<p>Promote another member to Super admin or delete those organizations first.</p>
						</div>
					</ModalBody>
					<ModalFooter>
						<Button variant="secondary" size="sm" onClick={() => setShowBlockersModal(false)}>
							OK
						</Button>
					</ModalFooter>
				</Modal>
			)}
		</div>
	);
}
