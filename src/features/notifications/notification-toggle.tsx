import { Bell, BellOff, BellRing } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast-store';
import { Tooltip } from '@/components/ui/tooltip';
import { usePushNotifications } from '@/hooks/use-push-notifications';
import { cn } from '@/lib/utils';

export function NotificationToggle() {
	const { permissionState, isSubscribed, isEnabled, isLoading, needsPermissionApproval, subscribe, toggleEnabled } = usePushNotifications();

	// Don't render if push is not supported
	// eslint-disable-next-line unicorn/no-null -- React expects null for "render nothing"
	if (permissionState === 'unsupported') return null;

	function handleClick() {
		if (isSubscribed) {
			void toggleEnabled();
		} else {
			void subscribe();
		}
	}

	// Permission denied — show disabled-looking bell that explains how to unblock
	if (permissionState === 'denied') {
		return (
			<Tooltip content="Notifications blocked">
				<Button
					variant="ghost"
					size="icon"
					aria-label="Notifications blocked"
					onClick={() => toast.info('Allow notifications for this site in your browser settings, then try again.')}
				>
					<BellOff className="size-4 text-text-secondary" />
				</Button>
			</Tooltip>
		);
	}

	const tooltipContent = isSubscribed
		? isEnabled
			? 'Notifications enabled'
			: 'Notifications disabled'
		: needsPermissionApproval
			? 'Approve notifications in your browser'
			: 'Enable notifications';

	return (
		<Tooltip content={tooltipContent} forceOpen={needsPermissionApproval}>
			<Button
				variant="ghost"
				size="icon"
				aria-label={tooltipContent}
				aria-busy={isLoading}
				onClick={handleClick}
				isLoading={isLoading}
				className={cn(
					'relative',
					isLoading && 'disabled:opacity-100',
					needsPermissionApproval &&
						`
							bg-accent/6 text-accent ring-1 ring-accent/15 ring-inset
							hover:bg-accent/10 hover:text-accent
							disabled:opacity-100
						`,
				)}
			>
				{isSubscribed && isEnabled ? (
					<BellRing className={cn('size-4', 'text-accent')} />
				) : (
					<Bell className={cn('size-4', needsPermissionApproval && 'animate-pulse text-accent')} />
				)}
			</Button>
		</Tooltip>
	);
}
