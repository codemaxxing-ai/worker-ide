import { useCallback, useEffect, useRef, useState } from 'react';

import { toast } from '@/components/ui/toast-store';
import { createUserApiClient } from '@/lib/api-client';
import { acquirePushSubscription, getPushSubscription } from '@/lib/push-subscription';

type PermissionState = 'default' | 'granted' | 'denied' | 'unsupported';

interface UsePushNotificationsResult {
	permissionState: PermissionState;
	isSubscribed: boolean;
	isEnabled: boolean;
	isLoading: boolean;
	needsPermissionApproval: boolean;
	subscribe: () => Promise<void>;
	toggleEnabled: () => Promise<void>;
}

const userApi = createUserApiClient();
const PUSH_STATE_CHANNEL = 'worker-ide-push-state';
const PUSH_STATE_CHECK_INTERVAL_MS = 30_000;

function isPushSupported(): boolean {
	return 'serviceWorker' in navigator && 'PushManager' in globalThis && 'Notification' in globalThis;
}

function getPermissionState(): PermissionState {
	if (!isPushSupported()) return 'unsupported';
	return Notification.permission;
}

async function registerPushSubscription(subscription: PushSubscription, enabled?: boolean): Promise<boolean> {
	const subscriptionJson = subscription.toJSON();
	const key = subscriptionJson.keys?.p256dh;
	const auth = subscriptionJson.keys?.auth;
	if (!subscription.endpoint || !key || !auth) {
		throw new Error('Invalid push subscription: missing required fields');
	}

	const response = await userApi.user['push-subscription'].$post({
		json: { endpoint: subscription.endpoint, key, auth, enabled },
	});
	if (!response.ok) throw new Error('Failed to register push subscription');
	const preference = await response.json();
	return preference.enabled;
}

async function createPushSubscription(): Promise<PushSubscription> {
	const response = await userApi.user['push-vapid-key'].$get({});
	if (!response.ok) throw new Error('Failed to fetch VAPID key');
	const { key } = await response.json();
	return acquirePushSubscription(key);
}

export function usePushNotifications(): UsePushNotificationsResult {
	const [permissionState, setPermissionState] = useState<PermissionState>(getPermissionState);
	const [isSubscribed, setIsSubscribed] = useState(false);
	const [isEnabled, setIsEnabled] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [isAwaitingPermission, setIsAwaitingPermission] = useState(false);

	const operationReference = useRef(false);
	const mountedReference = useRef(false);
	const pendingSyncReference = useRef(false);
	const enabledPreferenceReference = useRef<boolean | undefined>(undefined);
	const channelReference = useRef<BroadcastChannel | undefined>(undefined);

	const refreshPermission = useCallback(() => {
		const permission = getPermissionState();
		if (!mountedReference.current) return permission;
		setPermissionState(permission);
		if (permission !== 'granted') {
			setIsSubscribed(false);
			setIsEnabled(false);
		}
		return permission;
	}, []);

	const publishChange = useCallback(() => {
		channelReference.current?.postMessage('push-state-changed');
	}, []);

	const syncPushState = useCallback(
		async function reconcilePushState() {
			if (!isPushSupported() || !mountedReference.current) return;
			const permission = refreshPermission();
			if (operationReference.current) {
				pendingSyncReference.current = true;
				return;
			}
			if (permission !== 'granted') return;

			operationReference.current = true;
			setIsLoading(true);
			try {
				let subscription = await getPushSubscription();
				if (!mountedReference.current || refreshPermission() !== 'granted') return;

				let enabled: boolean;
				if (subscription?.endpoint) {
					const response = await userApi.user['push-notification-preference'].$get({
						query: { endpoint: subscription.endpoint },
					});
					if (!response.ok) throw new Error('Failed to get notification preference');
					const preference = await response.json();
					if (!mountedReference.current || refreshPermission() !== 'granted') return;
					if (preference.registered) {
						enabled = preference.enabled;
					} else {
						setIsSubscribed(false);
						setIsEnabled(false);
						enabled = await registerPushSubscription(subscription, enabledPreferenceReference.current);
					}
				} else {
					setIsSubscribed(false);
					setIsEnabled(false);
					subscription = await createPushSubscription();
					if (!mountedReference.current || refreshPermission() !== 'granted') return;
					enabled = await registerPushSubscription(subscription, enabledPreferenceReference.current);
				}

				if (!mountedReference.current || refreshPermission() !== 'granted' || pendingSyncReference.current) return;
				enabledPreferenceReference.current = enabled;
				setIsSubscribed(true);
				setIsEnabled(enabled);
			} catch {
				// Preserve valid subscriptions during outages; retry on focus or reconnect.
			} finally {
				operationReference.current = false;
				if (mountedReference.current) {
					refreshPermission();
					setIsLoading(false);
					if (pendingSyncReference.current) {
						pendingSyncReference.current = false;
						void reconcilePushState();
					}
				}
			}
		},
		[refreshPermission],
	);

	const finishOperation = useCallback(() => {
		operationReference.current = false;
		if (!mountedReference.current) return;
		refreshPermission();
		setIsAwaitingPermission(false);
		setIsLoading(false);
		if (pendingSyncReference.current) {
			pendingSyncReference.current = false;
			void syncPushState();
		}
	}, [refreshPermission, syncPushState]);

	useEffect(() => {
		if (!isPushSupported()) return;

		mountedReference.current = true;
		const serviceWorker = navigator.serviceWorker;
		void Promise.resolve().then(syncPushState);

		const handlePermissionChange = () => {
			setIsAwaitingPermission(false);
			void syncPushState();
		};
		const handleWindowFocus = () => {
			void syncPushState();
		};
		const handleVisibilityChange = () => {
			if (document.visibilityState !== 'visible') return;
			void syncPushState();
		};
		const handleServiceWorkerMessage = (event: MessageEvent<unknown>) => {
			if (event.data === 'push-state-changed') void syncPushState();
		};
		const checkVisibleState = () => {
			if (document.visibilityState === 'visible') void syncPushState();
		};
		const interval = setInterval(checkVisibleState, PUSH_STATE_CHECK_INTERVAL_MS);

		try {
			channelReference.current = new BroadcastChannel(PUSH_STATE_CHANNEL);
			channelReference.current.addEventListener('message', handleWindowFocus);
		} catch {
			// Periodic checks also cover browsers without BroadcastChannel.
		}

		window.addEventListener('focus', handleWindowFocus);
		globalThis.addEventListener('online', handleWindowFocus);
		document.addEventListener('visibilitychange', handleVisibilityChange);
		serviceWorker.addEventListener('controllerchange', handleWindowFocus);
		serviceWorker.addEventListener('message', handleServiceWorkerMessage);

		let permissionStatus: PermissionStatus | undefined;
		let cancelled = false;
		if ('permissions' in navigator) {
			void navigator.permissions
				.query({ name: 'notifications' })
				.then((status) => {
					if (cancelled) return;
					permissionStatus = status;
					status.addEventListener('change', handlePermissionChange);
				})
				.catch(() => {
					// Permissions API unsupported — fall back to focus/visibility sync.
				});
		}

		return () => {
			cancelled = true;
			mountedReference.current = false;
			clearInterval(interval);
			channelReference.current?.close();
			channelReference.current = undefined;
			window.removeEventListener('focus', handleWindowFocus);
			globalThis.removeEventListener('online', handleWindowFocus);
			document.removeEventListener('visibilitychange', handleVisibilityChange);
			serviceWorker.removeEventListener('controllerchange', handleWindowFocus);
			serviceWorker.removeEventListener('message', handleServiceWorkerMessage);
			permissionStatus?.removeEventListener('change', handlePermissionChange);
		};
	}, [syncPushState]);

	const subscribe = useCallback(async () => {
		if (!isPushSupported() || operationReference.current) return;
		operationReference.current = true;
		setIsLoading(true);
		setIsAwaitingPermission(getPermissionState() === 'default');

		try {
			// 1. Request notification permission
			const permission = await Notification.requestPermission();
			if (!mountedReference.current) return;
			setPermissionState(permission);
			setIsAwaitingPermission(false);
			if (permission !== 'granted') return;

			const subscription = await createPushSubscription();
			if (!mountedReference.current || refreshPermission() !== 'granted') return;
			const enabled = await registerPushSubscription(subscription, true);
			publishChange();
			if (!mountedReference.current || refreshPermission() !== 'granted') return;

			enabledPreferenceReference.current = enabled;
			setIsSubscribed(true);
			setIsEnabled(enabled);
		} catch {
			pendingSyncReference.current = true;
			if (mountedReference.current) toast.error('Could not enable notifications. Please check your browser permissions and try again.');
		} finally {
			finishOperation();
		}
	}, [finishOperation, publishChange, refreshPermission]);

	const toggleEnabled = useCallback(async () => {
		if (!isPushSupported() || operationReference.current || refreshPermission() !== 'granted') return;
		operationReference.current = true;
		setIsLoading(true);

		try {
			let subscription = await getPushSubscription();
			if (!mountedReference.current || refreshPermission() !== 'granted') return;
			if (!subscription) {
				setIsSubscribed(false);
				setIsEnabled(false);
				subscription = await createPushSubscription();
			}
			if (!mountedReference.current || refreshPermission() !== 'granted') return;
			const enabled = await registerPushSubscription(subscription, !isEnabled);
			publishChange();
			if (!mountedReference.current || refreshPermission() !== 'granted') return;
			enabledPreferenceReference.current = enabled;
			setIsSubscribed(true);
			setIsEnabled(enabled);
		} catch {
			pendingSyncReference.current = true;
			if (mountedReference.current) toast.error('Could not update notification preference. Please try again.');
		} finally {
			finishOperation();
		}
	}, [finishOperation, isEnabled, publishChange, refreshPermission]);

	return {
		permissionState,
		isSubscribed,
		isEnabled,
		isLoading,
		needsPermissionApproval: isAwaitingPermission,
		subscribe,
		toggleEnabled,
	};
}
