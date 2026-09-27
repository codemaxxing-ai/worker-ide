import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InviteForm, MemberRow } from './org-membership';

import type { OrgDetails } from '@/lib/api-client';

const { inviteMember, toastSuccess } = vi.hoisted(() => ({ inviteMember: vi.fn(), toastSuccess: vi.fn() }));

vi.mock('@/lib/auth-client', () => ({ authClient: { organization: { inviteMember } } }));
vi.mock('@/components/ui/toast-store', () => ({ toast: { error: vi.fn(), success: toastSuccess } }));

const member: OrgDetails['members'][number] = {
	id: 'member-1',
	userId: 'user-1',
	role: 'member',
	createdAt: '2026-01-01T00:00:00.000Z',
	user: { id: 'user-1', name: 'Alice', email: 'alice@example.com', image: undefined },
};

describe('organization membership controls', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('shows owner actions for another member and sends the requested role change', async () => {
		const onChangeRole = vi.fn();
		render(
			<MemberRow
				member={member}
				currentUserId="owner-1"
				isOwner
				onRemove={() => {}}
				onTransferOwnership={() => {}}
				onChangeRole={onChangeRole}
			/>,
		);

		expect(screen.getByTitle('Transfer ownership')).toBeInTheDocument();
		expect(screen.getByTitle('Remove member')).toBeInTheDocument();
		await userEvent.click(screen.getByTitle('Promote to admin'));
		expect(onChangeRole).toHaveBeenCalledWith(member, 'admin', 'promote');
	});

	it('disables invitations at the member cap', () => {
		render(
			<InviteForm
				organizationId="org-1"
				memberCount={5}
				pendingInvitationCount={0}
				maxMembers={5}
				maxPendingInvitations={10}
				onInvited={() => {}}
			/>,
		);
		expect(screen.getByText('Member limit reached (5).')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Invite' })).toBeDisabled();
	});

	it('sends an invitation and refreshes membership after success', async () => {
		inviteMember.mockResolvedValue({ error: undefined });
		const onInvited = vi.fn();
		render(
			<InviteForm
				organizationId="org-1"
				memberCount={2}
				pendingInvitationCount={0}
				maxMembers={5}
				maxPendingInvitations={10}
				onInvited={onInvited}
			/>,
		);
		await userEvent.type(screen.getByRole('textbox'), 'new@example.com');
		await userEvent.click(screen.getByRole('button', { name: 'Invite' }));
		await waitFor(() => {
			expect(inviteMember).toHaveBeenCalledWith({ email: 'new@example.com', role: 'member', organizationId: 'org-1' });
			expect(onInvited).toHaveBeenCalledOnce();
			expect(toastSuccess).toHaveBeenCalledWith('Invitation sent to new@example.com');
		});
	});
});
