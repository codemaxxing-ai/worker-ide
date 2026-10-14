import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationToggle } from './notification-toggle';

const { usePushNotificationsMock } = vi.hoisted(() => ({
	usePushNotificationsMock: vi.fn(),
}));

vi.mock('@/hooks/use-push-notifications', () => ({
	usePushNotifications: () => usePushNotificationsMock(),
}));

describe('NotificationToggle', () => {
	beforeEach(() => {
		usePushNotificationsMock.mockReset();
	});

	it('keeps the default notification button in its normal state before any prompt is shown', () => {
		usePushNotificationsMock.mockReturnValue({
			permissionState: 'default',
			isSubscribed: false,
			isEnabled: false,
			isLoading: false,
			needsPermissionApproval: false,
			subscribe: vi.fn(),
			toggleEnabled: vi.fn(),
		});

		render(<NotificationToggle />);

		const button = screen.getByRole('button', { name: 'Enable notifications' });
		expect(button).toBeInTheDocument();
		expect(button.querySelector('svg')).not.toHaveClass('animate-pulse');
	});

	it('shows a spinner and the approval prompt while browser permission is pending', () => {
		usePushNotificationsMock.mockReturnValue({
			permissionState: 'default',
			isSubscribed: false,
			isEnabled: false,
			isLoading: true,
			needsPermissionApproval: true,
			subscribe: vi.fn(),
			toggleEnabled: vi.fn(),
		});

		render(<NotificationToggle />);

		const button = screen.getByRole('button', { name: 'Approve notifications in your browser' });
		expect(button).toBeDisabled();
		expect(button).toHaveAttribute('aria-busy', 'true');
		expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
		expect(screen.getByRole('tooltip')).toHaveTextContent('Approve notifications in your browser');
	});

	it.each([
		{ isSubscribed: false, isEnabled: false, label: 'Enable notifications' },
		{ isSubscribed: true, isEnabled: false, label: 'Notifications disabled' },
		{ isSubscribed: true, isEnabled: true, label: 'Notifications enabled' },
	])('keeps the $label button size while showing a spinner during activation', ({ isSubscribed, isEnabled, label }) => {
		const notificationState = {
			permissionState: 'granted',
			isSubscribed,
			isEnabled,
			isLoading: false,
			needsPermissionApproval: false,
			subscribe: vi.fn(),
			toggleEnabled: vi.fn(),
		};
		usePushNotificationsMock.mockReturnValue(notificationState);
		const { rerender } = render(<NotificationToggle />);
		const button = screen.getByRole('button', { name: label });
		const bell = button.querySelector('svg');
		expect(button).toHaveClass('size-8');
		expect(button).toBeEnabled();
		expect(screen.queryByRole('status')).not.toBeInTheDocument();

		usePushNotificationsMock.mockReturnValue({ ...notificationState, isLoading: true });
		rerender(<NotificationToggle />);

		expect(screen.getByRole('button', { name: label })).toBe(button);
		expect(button).toHaveClass('size-8', 'disabled:opacity-100');
		expect(button).toBeDisabled();
		expect(button).toHaveAttribute('aria-busy', 'true');
		expect(bell).toBeInTheDocument();
		expect(bell?.parentElement).toHaveClass('invisible');
		const spinner = screen.getByRole('status', { name: 'Loading' });
		expect(spinner).toHaveClass('size-4');
		expect(spinner.parentElement).toHaveClass('absolute', 'inset-0');

		usePushNotificationsMock.mockReturnValue(notificationState);
		rerender(<NotificationToggle />);

		expect(button).toHaveClass('size-8');
		expect(button).toBeEnabled();
		expect(button).toHaveAttribute('aria-busy', 'false');
		expect(bell?.parentElement).not.toHaveClass('invisible');
		expect(screen.queryByRole('status')).not.toBeInTheDocument();
	});

	it('does not show the approval pulse after permission is denied', () => {
		usePushNotificationsMock.mockReturnValue({
			permissionState: 'denied',
			isSubscribed: false,
			isEnabled: false,
			isLoading: false,
			needsPermissionApproval: false,
			subscribe: vi.fn(),
			toggleEnabled: vi.fn(),
		});

		render(<NotificationToggle />);

		const button = screen.getByRole('button', { name: 'Notifications blocked' });
		expect(button).toBeInTheDocument();
		expect(button.querySelector('svg')).not.toHaveClass('animate-pulse');
	});
});
