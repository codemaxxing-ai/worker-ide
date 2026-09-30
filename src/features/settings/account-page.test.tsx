import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api-error';

import AccountPage from './account-page';

const mocks = vi.hoisted(() => ({
	fetchActiveSessions: vi.fn(),
	fetchReauthenticationProviders: vi.fn(),
	linkSocial: vi.fn(),
	revokeActiveSession: vi.fn(),
	revokeOtherActiveSessions: vi.fn(),
	signOut: vi.fn(),
	useSession: vi.fn(),
	deleteAccount: vi.fn(),
	fetchAccountDeletePreview: vi.fn(),
	toastError: vi.fn(),
	toastSuccess: vi.fn(),
}));

vi.mock('@/lib/auth-client', () => ({
	authClient: {
		useSession: mocks.useSession,
		signOut: mocks.signOut,
		linkSocial: mocks.linkSocial,
	},
}));

vi.mock('@/lib/api-client', () => ({
	deleteAccount: mocks.deleteAccount,
	fetchAccountDeletePreview: mocks.fetchAccountDeletePreview,
	fetchActiveSessions: mocks.fetchActiveSessions,
	fetchReauthenticationProviders: mocks.fetchReauthenticationProviders,
	revokeActiveSession: mocks.revokeActiveSession,
	revokeOtherActiveSessions: mocks.revokeOtherActiveSessions,
}));

vi.mock('@/components/ui/toast-store', () => ({
	toast: {
		error: mocks.toastError,
		success: mocks.toastSuccess,
	},
}));

function renderAccountPage(path = '/settings/account') {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: {
				retry: false,
			},
		},
	});

	return render(
		<MemoryRouter initialEntries={[path]}>
			<QueryClientProvider client={queryClient}>
				<AccountPage />
			</QueryClientProvider>
		</MemoryRouter>,
	);
}

async function clickDialogButton(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, name: string) {
	const button = within(dialog).getByRole('button', { name });
	await waitFor(() => expect(getComputedStyle(button).pointerEvents).not.toBe('none'));
	await user.click(button);
}

async function openVerification() {
	mocks.revokeActiveSession.mockRejectedValue(new ApiError('Sign in again to manage sessions', 403, 'SESSION_NOT_FRESH'));
	const user = userEvent.setup();
	renderAccountPage();
	await user.click(await screen.findByRole('button', { name: 'Revoke' }));
	await clickDialogButton(user, await screen.findByRole('dialog', { name: 'Revoke this session?' }), 'Revoke');
	return { user, dialog: await screen.findByRole('dialog', { name: 'Verify it’s you' }) };
}

describe('AccountPage', () => {
	beforeEach(() => {
		mocks.useSession.mockReturnValue({
			data: {
				user: {
					email: 'taylor@example.com',
				},
			},
		});
		mocks.fetchActiveSessions.mockResolvedValue([
			{
				id: 'current-session',
				userAgent: 'Desktop Chrome',
				ipAddress: '127.0.0.1',
				createdAt: '2026-04-20T12:00:00.000Z',
				current: true,
			},
			{
				id: 'other-session',
				userAgent: 'iPhone Mobile Safari',
				ipAddress: '127.0.0.2',
				createdAt: '2026-04-18T12:00:00.000Z',
				current: false,
			},
		]);
		mocks.revokeActiveSession.mockImplementation(() => Promise.resolve());
		mocks.revokeOtherActiveSessions.mockImplementation(() => Promise.resolve());
		mocks.signOut.mockResolvedValue({ data: undefined, error: undefined });
		mocks.signOut.mockClear();
		mocks.linkSocial.mockReset().mockResolvedValue({ error: undefined });
		mocks.fetchReauthenticationProviders.mockResolvedValue(['github']);
		mocks.toastError.mockReset();
		mocks.toastSuccess.mockReset();
	});

	it('formats IPv6 session addresses without hiding the revoke action', async () => {
		mocks.fetchActiveSessions.mockResolvedValue([
			{
				id: 'other-session',
				userAgent: 'iPhone Mobile Safari',
				ipAddress: '2001:0DB8:0000:0000:0000:0000:0000:0001',
				createdAt: '2026-04-18T12:00:00.000Z',
				current: false,
			},
		]);
		renderAccountPage();
		expect(await screen.findByText('2001:db8::1')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
	});

	it('confirms before revoking an individual session', async () => {
		const user = userEvent.setup();
		renderAccountPage();

		await screen.findByRole('button', { name: 'Revoke' });
		await user.click(screen.getByRole('button', { name: 'Revoke' }));

		const revokeDialog = await screen.findByRole('dialog', { name: 'Revoke this session?' });

		await clickDialogButton(user, revokeDialog, 'Revoke');

		await waitFor(() => expect(mocks.revokeActiveSession).toHaveBeenCalledWith('other-session'));
	});

	it('confirms before signing out all other sessions', async () => {
		const user = userEvent.setup();
		renderAccountPage();

		await screen.findByRole('button', { name: 'Sign out all others' });
		await user.click(screen.getByRole('button', { name: 'Sign out all others' }));

		const signOutDialog = await screen.findByRole('dialog', { name: 'Sign out all sessions?' });

		await clickDialogButton(user, signOutDialog, 'Sign out');

		await waitFor(() => expect(mocks.revokeOtherActiveSessions).toHaveBeenCalledTimes(1));
	});

	it('asks the user to sign in again when the current session is not fresh', async () => {
		mocks.revokeActiveSession.mockRejectedValue(new ApiError('Sign in again to manage sessions', 403, 'SESSION_NOT_FRESH'));
		const user = userEvent.setup();
		renderAccountPage();

		await user.click(await screen.findByRole('button', { name: 'Revoke' }));
		const revokeDialog = await screen.findByRole('dialog', { name: 'Revoke this session?' });
		await clickDialogButton(user, revokeDialog, 'Revoke');

		const reauthenticationDialog = await screen.findByRole('dialog', { name: 'Verify it’s you' });
		expect(within(reauthenticationDialog).queryByText(/current session stays signed in/)).not.toBeInTheDocument();
		await within(reauthenticationDialog).findByRole('button', { name: 'Verify with GitHub' });
		await clickDialogButton(user, reauthenticationDialog, 'Verify with GitHub');
		expect(mocks.linkSocial).toHaveBeenCalledWith(
			expect.objectContaining({ provider: 'github', additionalData: { intent: 'reauthenticate' } }),
		);
		expect(mocks.signOut).not.toHaveBeenCalled();
		expect(within(reauthenticationDialog).queryByRole('button', { name: 'Verify with Google' })).not.toBeInTheDocument();
	});

	it('offers configured linked providers and cancels without signing out', async () => {
		mocks.fetchReauthenticationProviders.mockResolvedValue(['google', 'github']);
		const { user, dialog } = await openVerification();
		expect(await within(dialog).findByRole('button', { name: 'Verify with Google' })).toBeInTheDocument();
		expect(within(dialog).getByRole('button', { name: 'Verify with GitHub' })).toBeInTheDocument();
		await clickDialogButton(user, dialog, 'Cancel');
		expect(mocks.linkSocial).not.toHaveBeenCalled();
		expect(mocks.signOut).not.toHaveBeenCalled();
	});

	it('leaves the session intact when provider verification cannot start', async () => {
		mocks.linkSocial.mockResolvedValue({ error: { message: 'Provider unavailable' } });
		const { user, dialog } = await openVerification();
		await within(dialog).findByRole('button', { name: 'Verify with GitHub' });
		await clickDialogButton(user, dialog, 'Verify with GitHub');
		await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Could not start verification.'));
		expect(mocks.signOut).not.toHaveBeenCalled();
	});

	it.each(['success', 'error'])('shows %s feedback without retrying a sensitive action', async (result) => {
		renderAccountPage(`/settings/account?reauth=${result}`);
		expect(await screen.findByRole('status')).toHaveTextContent(
			result === 'success' ? 'Identity verified. Retry your action.' : 'Verification was not completed.',
		);
		expect(mocks.linkSocial).not.toHaveBeenCalled();
		expect(mocks.signOut).not.toHaveBeenCalled();
	});
});
