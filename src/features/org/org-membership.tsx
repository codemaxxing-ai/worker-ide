import { ChevronDown, ChevronUp, Crown, Mail, Shield, Trash2, User, UserPlus, X } from 'lucide-react';
import { useCallback, useState } from 'react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast-store';
import { authClient } from '@/lib/auth-client';
import { cn } from '@/lib/utils';

import type { OrgDetails } from '@/lib/api-client';

type OrgMember = OrgDetails['members'][number];
type OrgInvitation = OrgDetails['invitations'][number];

const ROLE_CONFIG: Record<string, { label: string; icon: typeof Crown; className: string }> = {
	owner: { label: 'Owner', icon: Crown, className: 'bg-warning/15 text-warning' },
	admin: { label: 'Admin', icon: Shield, className: 'bg-accent/15 text-accent' },
	member: { label: 'Member', icon: User, className: 'bg-bg-tertiary text-text-secondary' },
};

function RoleBadge({ role }: { role: string }) {
	const config = ROLE_CONFIG[role] ?? ROLE_CONFIG.member;
	const Icon = config.icon;
	return (
		<span className={cn('inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium', config.className)}>
			<Icon className="size-3" />
			{config.label}
		</span>
	);
}

function MemberRow({
	member,
	currentUserId,
	isOwner,
	onRemove,
	onTransferOwnership,
	onChangeRole,
}: {
	member: OrgMember;
	currentUserId: string;
	isOwner: boolean;
	onRemove: (member: OrgMember) => void;
	onTransferOwnership: (member: OrgMember) => void;
	onChangeRole: (member: OrgMember, targetRole: string, direction: 'promote' | 'demote') => void;
}) {
	const isSelf = member.userId === currentUserId;
	const canRemove = isOwner && !isSelf && member.role !== 'owner';
	const canTransfer = isOwner && !isSelf && member.role !== 'owner';
	const canPromote = isOwner && !isSelf && member.role === 'member';
	const canDemote = isOwner && !isSelf && member.role === 'admin';

	return (
		<div className="flex items-center justify-between gap-3 px-4 py-3">
			<div className="flex min-w-0 items-center gap-3">
				<div
					className="
						flex size-8 shrink-0 items-center justify-center rounded-full
						bg-bg-tertiary text-xs font-medium text-text-secondary
					"
				>
					{member.user.name.charAt(0).toUpperCase()}
				</div>
				<div className="min-w-0">
					<p className="truncate text-sm font-medium text-text-primary">
						{member.user.name}
						{isSelf && <span className="ml-1 text-xs font-normal text-text-secondary">(you)</span>}
					</p>
					<p className="truncate text-xs text-text-secondary">{member.user.email}</p>
				</div>
			</div>
			<div className="flex shrink-0 items-center gap-2">
				<RoleBadge role={member.role} />
				{canPromote && (
					<button
						onClick={() => onChangeRole(member, 'admin', 'promote')}
						title="Promote to admin"
						className="
							cursor-pointer rounded-md p-1.5 text-text-secondary transition-colors
							hover:bg-bg-tertiary hover:text-accent
						"
					>
						<ChevronUp className="size-3.5" />
					</button>
				)}
				{canDemote && (
					<button
						onClick={() => onChangeRole(member, 'member', 'demote')}
						title="Demote to member"
						className="
							cursor-pointer rounded-md p-1.5 text-text-secondary transition-colors
							hover:bg-bg-tertiary hover:text-text-primary
						"
					>
						<ChevronDown className="size-3.5" />
					</button>
				)}
				{canTransfer && (
					<button
						onClick={() => onTransferOwnership(member)}
						title="Transfer ownership"
						className="
							cursor-pointer rounded-md p-1.5 text-text-secondary transition-colors
							hover:bg-bg-tertiary hover:text-warning
						"
					>
						<Crown className="size-3.5" />
					</button>
				)}
				{canRemove && (
					<button
						onClick={() => onRemove(member)}
						title="Remove member"
						className="
							cursor-pointer rounded-md p-1.5 text-text-secondary transition-colors
							hover:bg-bg-tertiary hover:text-error
						"
					>
						<Trash2 className="size-3.5" />
					</button>
				)}
			</div>
		</div>
	);
}

function InvitationRow({
	invitation,
	canCancel,
	onCancel,
}: {
	invitation: OrgInvitation;
	canCancel: boolean;
	onCancel: (invitationId: string) => void;
}) {
	return (
		<div className="flex items-center justify-between gap-3 px-4 py-3">
			<div className="flex min-w-0 items-center gap-3">
				<div
					className="
						flex size-8 shrink-0 items-center justify-center rounded-full
						bg-bg-tertiary text-text-secondary
					"
				>
					<Mail className="size-3.5" />
				</div>
				<div className="min-w-0">
					<p className="truncate text-sm text-text-primary">{invitation.email}</p>
					<p className="text-xs text-text-secondary">Pending &middot; {invitation.role ?? 'member'}</p>
				</div>
			</div>
			{canCancel && (
				<button
					onClick={() => onCancel(invitation.id)}
					title="Cancel invitation"
					className="
						shrink-0 cursor-pointer rounded-md p-1.5 text-text-secondary
						transition-colors
						hover:bg-bg-tertiary hover:text-error
					"
				>
					<X className="size-3.5" />
				</button>
			)}
		</div>
	);
}

function InviteForm({
	organizationId,
	memberCount,
	pendingInvitationCount,
	maxMembers,
	maxPendingInvitations,
	onInvited,
}: {
	organizationId: string;
	memberCount: number;
	pendingInvitationCount: number;
	maxMembers: number;
	maxPendingInvitations: number;
	onInvited: () => void;
}) {
	const [email, setEmail] = useState('');
	const [role, setRole] = useState<'member' | 'admin'>('member');
	const [isSending, setIsSending] = useState(false);

	const memberLimitReached = memberCount >= maxMembers;
	const invitationLimitReached = pendingInvitationCount >= maxPendingInvitations;
	const isLimitReached = memberLimitReached || invitationLimitReached;

	const handleInvite = useCallback(async () => {
		const trimmed = email.trim();
		if (!trimmed) return;

		setIsSending(true);
		try {
			const { error } = await authClient.organization.inviteMember({
				email: trimmed,
				role,
				organizationId,
			});
			if (error) {
				toast.error(error.message ?? 'Failed to send invitation');
				return;
			}
			toast.success(`Invitation sent to ${trimmed}`);
			setEmail('');
			onInvited();
		} catch {
			toast.error('Failed to send invitation');
		} finally {
			setIsSending(false);
		}
	}, [email, role, organizationId, onInvited]);

	return (
		<div className="px-4 py-3">
			<label className="mb-1.5 block text-xs font-medium text-text-secondary">Email address</label>
			<div className="flex items-center gap-2">
				<div className="relative min-w-0 flex-1">
					<UserPlus
						className="
							pointer-events-none absolute top-1/2 left-3 z-10 size-3.5
							-translate-y-1/2 text-text-secondary
						"
					/>
					<input
						type="email"
						value={email}
						onChange={(event) => setEmail(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === 'Enter' && email.trim() && !isLimitReached) {
								void handleInvite();
							}
						}}
						placeholder={isLimitReached ? 'Limit reached' : 'teammate@example.com'}
						disabled={isSending || isLimitReached}
						className="
							h-9 w-full rounded-md border border-border bg-bg-secondary/60 pr-3 pl-9
							text-xs text-text-primary backdrop-blur-sm transition-colors
							placeholder:text-text-secondary/50
							focus-within:border-accent
							focus:outline-none
						"
					/>
				</div>
				<div className="relative shrink-0">
					<select
						value={role}
						onChange={(event) => {
							const value = event.target.value;
							if (value === 'member' || value === 'admin') {
								setRole(value);
							}
						}}
						disabled={isSending || isLimitReached}
						className="
							h-9 appearance-none rounded-md border border-border bg-bg-secondary/60
							pr-7 pl-3 text-xs text-text-primary backdrop-blur-sm transition-colors
							focus:outline-none
						"
					>
						<option value="member">Member</option>
						<option value="admin">Admin</option>
					</select>
					<ChevronDown
						className="
							pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2
							text-text-secondary
						"
					/>
				</div>
				<Button
					size="sm"
					className="h-9 shrink-0"
					onClick={() => void handleInvite()}
					disabled={isSending || !email.trim() || isLimitReached}
					isLoading={isSending}
				>
					Invite
				</Button>
			</div>
			{isLimitReached && (
				<p className="mt-2 text-xs text-text-secondary/80">
					{memberLimitReached ? `Member limit reached (${maxMembers}).` : `Pending invitation limit reached (${maxPendingInvitations}).`}
				</p>
			)}
		</div>
	);
}

export { InvitationRow, InviteForm, MemberRow };
