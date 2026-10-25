import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationToggle } from '@/features/notifications/notification-toggle';

import { usePushNotifications } from './use-push-notifications';

const {
	pushNotificationPreferenceGet,
	pushNotificationPreferencePut,
	pushSubscriptionDelete,
	pushSubscriptionPost,
	pushVapidKeyGet,
	toastError,
} = vi.hoisted(() => ({
	pushNotificationPreferenceGet: vi.fn(),
	pushNotificationPreferencePut: vi.fn(),
	pushSubscriptionDelete: vi.fn(),
	pushSubscriptionPost: vi.fn(),
	pushVapidKeyGet: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock('@/components/ui/toast-store', () => ({
	toast: {
		error: toastError,
	},
}));

vi.mock('@/lib/api-client', () => ({
	createUserApiClient: () => ({
		user: {
			'push-notification-preference': {
				$get: pushNotificationPreferenceGet,
				$put: pushNotificationPreferencePut,
			},
			'push-subscription': {
				$post: pushSubscriptionPost,
				$delete: pushSubscriptionDelete,
			},
			'push-vapid-key': {
				$get: pushVapidKeyGet,
			},
		},
	}),
}));

interface MockPermissionStatus {
	state: PermissionState;
	addEventListener: ReturnType<typeof vi.fn>;
	removeEventListener: ReturnType<typeof vi.fn>;
}

class MockBroadcastChannel extends EventTarget {
	static instances: MockBroadcastChannel[] = [];
	postMessage(data: unknown) {
		for (const channel of MockBroadcastChannel.instances) {
			if (channel !== this) channel.dispatchEvent(new MessageEvent('message', { data }));
		}
	}
	close() {
		MockBroadcastChannel.instances = MockBroadcastChannel.instances.filter((channel) => channel !== this);
	}

	constructor() {
		super();
		MockBroadcastChannel.instances.push(this);
	}
}

describe('usePushNotifications', () => {
	const originalNotification = globalThis.Notification;
	const originalPushManager = globalThis.PushManager;
	const originalServiceWorker = navigator.serviceWorker;
	const originalPermissions = navigator.permissions;

	let permissionStatus: MockPermissionStatus;
	let permissionChangeListener: EventListener | undefined;
	let notificationPermission: NotificationPermission;
	let requestPermissionMock: ReturnType<typeof vi.fn>;
	let getSubscriptionMock: ReturnType<typeof vi.fn>;
	let subscribeMock: ReturnType<typeof vi.fn>;
	let serviceWorker: EventTarget;

	beforeEach(() => {
		toastError.mockReset();
		pushNotificationPreferenceGet.mockReset();
		pushNotificationPreferencePut.mockReset();
		pushSubscriptionDelete.mockReset();
		pushSubscriptionPost.mockReset();
		pushVapidKeyGet.mockReset();
		permissionChangeListener = undefined;
		notificationPermission = 'default';
		requestPermissionMock = vi.fn();
		getSubscriptionMock = vi.fn(async () => {});
		subscribeMock = vi.fn();
		MockBroadcastChannel.instances = [];
		vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);

		permissionStatus = {
			state: 'prompt',
			addEventListener: vi.fn((eventName: string, listener: EventListenerOrEventListenerObject) => {
				if (eventName === 'change' && typeof listener === 'function') {
					permissionChangeListener = listener;
				}
			}),
			removeEventListener: vi.fn((eventName: string, listener: EventListenerOrEventListenerObject) => {
				if (eventName === 'change' && listener === permissionChangeListener) {
					permissionChangeListener = undefined;
				}
			}),
		};

		pushVapidKeyGet.mockResolvedValue({
			ok: true,
			json: async () => ({ key: 'vapid-key' }),
		});
		pushSubscriptionPost.mockResolvedValue({ ok: true, json: async () => ({ enabled: true }) });
		pushNotificationPreferenceGet.mockResolvedValue({ ok: true, json: async () => ({ registered: true, enabled: true }) });

		Object.defineProperty(globalThis, 'Notification', {
			configurable: true,
			value: {
				requestPermission: requestPermissionMock,
				get permission() {
					return notificationPermission;
				},
			},
		});
		Object.defineProperty(globalThis, 'PushManager', {
			configurable: true,
			value: class MockPushManager {},
		});
		const registration = { active: {}, pushManager: { getSubscription: getSubscriptionMock, subscribe: subscribeMock } };
		serviceWorker = new EventTarget();
		Object.defineProperty(navigator, 'serviceWorker', {
			configurable: true,
			value: Object.assign(serviceWorker, { getRegistration: vi.fn(async () => registration), ready: Promise.resolve(registration) }),
		});
		Object.defineProperty(navigator, 'permissions', {
			configurable: true,
			value: {
				query: vi.fn(async () => permissionStatus),
			},
		});
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
		vi.useRealTimers();
		vi.restoreAllMocks();
		Object.defineProperty(globalThis, 'Notification', {
			configurable: true,
			value: originalNotification,
		});
		Object.defineProperty(globalThis, 'PushManager', {
			configurable: true,
			value: originalPushManager,
		});
		Object.defineProperty(navigator, 'serviceWorker', {
			configurable: true,
			value: originalServiceWorker,
		});
		Object.defineProperty(navigator, 'permissions', {
			configurable: true,
			value: originalPermissions,
		});
	});

	function createSubscription() {
		return {
			endpoint: 'https://push.example.com/device',
			toJSON: () => ({ keys: { p256dh: 'public-key', auth: 'auth-key' } }),
			unsubscribe: vi.fn(async () => true),
		};
	}

	it('does not show approval as pending before subscribe is requested', async () => {
		const { result } = renderHook(() => usePushNotifications());

		await waitFor(() => {
			expect(result.current.permissionState).toBe('default');
		});

		expect(result.current.needsPermissionApproval).toBe(false);
	});

	it('shows approval as pending only while the browser notification prompt is open', async () => {
		let resolvePermission: ((value: NotificationPermission) => void) | undefined;
		requestPermissionMock.mockImplementation(
			() =>
				new Promise<NotificationPermission>((resolve) => {
					resolvePermission = resolve;
				}),
		);

		const { result } = renderHook(() => usePushNotifications());

		await act(async () => {
			void result.current.subscribe();
		});

		await waitFor(() => {
			expect(result.current.needsPermissionApproval).toBe(true);
		});

		notificationPermission = 'default';
		permissionStatus.state = 'prompt';
		await act(async () => {
			resolvePermission?.('default');
		});

		await waitFor(() => {
			expect(result.current.needsPermissionApproval).toBe(false);
			expect(result.current.permissionState).toBe('default');
		});
	});

	it('updates when notification permission changes without a reload', async () => {
		const { result } = renderHook(() => usePushNotifications());

		await waitFor(() => {
			expect(permissionStatus.addEventListener).toHaveBeenCalled();
		});

		notificationPermission = 'denied';
		permissionStatus.state = 'denied';
		await act(async () => {
			permissionChangeListener?.(new Event('change'));
		});

		await waitFor(() => {
			expect(result.current.permissionState).toBe('denied');
		});
	});
	it('recovers a missing browser subscription when permission is already granted', async () => {
		notificationPermission = 'granted';
		subscribeMock.mockResolvedValue(createSubscription());
		const { result } = renderHook(() => usePushNotifications());
		await waitFor(() => expect(result.current.isEnabled).toBe(true));
		expect(result.current.isSubscribed).toBe(true);
		expect(subscribeMock).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: 'vapid-key' });
		expect(pushSubscriptionPost).toHaveBeenCalledWith({
			json: { endpoint: 'https://push.example.com/device', key: 'public-key', auth: 'auth-key', enabled: undefined },
		});
		expect(requestPermissionMock).not.toHaveBeenCalled();
	});

	it('repairs a missing server registration using the existing browser subscription', async () => {
		notificationPermission = 'granted';
		const subscription = createSubscription();
		getSubscriptionMock.mockResolvedValue(subscription);
		pushNotificationPreferenceGet.mockResolvedValue({ ok: true, json: async () => ({ registered: false, enabled: false }) });
		const { result } = renderHook(() => usePushNotifications());
		await waitFor(() => expect(result.current.isEnabled).toBe(true));
		expect(pushSubscriptionPost).toHaveBeenCalledOnce();
		expect(subscription.unsubscribe).not.toHaveBeenCalled();
		expect(subscribeMock).not.toHaveBeenCalled();
	});

	it.each([true, false])('preserves a registered device preference (enabled: %s)', async (enabled) => {
		notificationPermission = 'granted';
		getSubscriptionMock.mockResolvedValue(createSubscription());
		pushNotificationPreferenceGet.mockResolvedValue({ ok: true, json: async () => ({ registered: true, enabled }) });
		const { result } = renderHook(() => usePushNotifications());
		await waitFor(() => expect(result.current.isSubscribed).toBe(true));
		expect(result.current.isEnabled).toBe(enabled);
		expect(pushSubscriptionPost).not.toHaveBeenCalled();
		expect(requestPermissionMock).not.toHaveBeenCalled();
	});

	it.each([401, 503])('keeps the browser subscription after a %s response and retries on focus', async (status) => {
		notificationPermission = 'granted';
		const subscription = createSubscription();
		getSubscriptionMock.mockResolvedValue(subscription);
		pushNotificationPreferenceGet.mockResolvedValueOnce({ ok: false, status });
		const { result } = renderHook(() => usePushNotifications());
		await waitFor(() => expect(pushNotificationPreferenceGet).toHaveBeenCalledOnce());
		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(subscription.unsubscribe).not.toHaveBeenCalled();
		expect(pushSubscriptionPost).not.toHaveBeenCalled();
		await act(async () => {
			globalThis.dispatchEvent(new Event('focus'));
		});
		await waitFor(() => expect(result.current.isEnabled).toBe(true));
		expect(toastError).not.toHaveBeenCalled();
	});

	it('retries failed registration on reconnect without creating a second subscription', async () => {
		notificationPermission = 'granted';
		getSubscriptionMock.mockResolvedValue(createSubscription());
		pushNotificationPreferenceGet.mockResolvedValue({ ok: true, json: async () => ({ registered: false, enabled: false }) });
		pushSubscriptionPost.mockResolvedValueOnce({ ok: false });
		const { result } = renderHook(() => usePushNotifications());
		await waitFor(() => expect(pushSubscriptionPost).toHaveBeenCalledOnce());
		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(result.current.isSubscribed).toBe(false);
		await act(async () => {
			globalThis.dispatchEvent(new Event('online'));
		});
		await waitFor(() => expect(result.current.isEnabled).toBe(true));
		expect(pushSubscriptionPost).toHaveBeenCalledTimes(2);
		expect(subscribeMock).not.toHaveBeenCalled();
	});

	it.each(['default', 'denied'])('does not automatically subscribe with %s permission', async (permission) => {
		notificationPermission = permission === 'default' ? 'default' : 'denied';
		renderHook(() => usePushNotifications());
		await act(async () => {
			globalThis.dispatchEvent(new Event('online'));
		});
		expect(getSubscriptionMock).not.toHaveBeenCalled();
		expect(requestPermissionMock).not.toHaveBeenCalled();
		expect(pushSubscriptionPost).not.toHaveBeenCalled();
	});

	it('recovers when permission is granted in browser settings', async () => {
		subscribeMock.mockResolvedValue(createSubscription());
		const { result } = renderHook(() => usePushNotifications());
		await waitFor(() => expect(permissionStatus.addEventListener).toHaveBeenCalled());
		notificationPermission = 'granted';
		await act(async () => {
			permissionChangeListener?.(new Event('change'));
		});
		await waitFor(() => expect(result.current.isEnabled).toBe(true));
		expect(requestPermissionMock).not.toHaveBeenCalled();
	});

	it('serializes overlapping recovery events', async () => {
		notificationPermission = 'granted';
		getSubscriptionMock.mockResolvedValue(createSubscription());
		let finishRegistration: (() => void) | undefined;
		pushSubscriptionPost.mockImplementation(
			() =>
				new Promise((resolve) => {
					finishRegistration = () => resolve({ ok: true, json: async () => ({ enabled: true }) });
				}),
		);
		pushNotificationPreferenceGet.mockResolvedValueOnce({ ok: true, json: async () => ({ registered: false, enabled: false }) });
		const { result } = renderHook(() => usePushNotifications());
		await waitFor(() => expect(pushSubscriptionPost).toHaveBeenCalledOnce());
		await act(async () => {
			globalThis.dispatchEvent(new Event('focus'));
			globalThis.dispatchEvent(new Event('online'));
			document.dispatchEvent(new Event('visibilitychange'));
			finishRegistration?.();
		});
		await waitFor(() => expect(result.current.isEnabled).toBe(true));
		expect(pushSubscriptionPost).toHaveBeenCalledOnce();
		expect(pushNotificationPreferenceGet).toHaveBeenCalledTimes(2);
	});

	it('does not register after unmounting while reading the browser subscription', async () => {
		notificationPermission = 'granted';
		let finishSubscription: (() => void) | undefined;
		getSubscriptionMock.mockImplementation(
			() =>
				new Promise((resolve) => {
					finishSubscription = () => resolve(createSubscription());
				}),
		);
		const { unmount } = renderHook(() => usePushNotifications());
		await waitFor(() => expect(getSubscriptionMock).toHaveBeenCalledOnce());
		unmount();
		await act(async () => {
			finishSubscription?.();
		});
		expect(pushNotificationPreferenceGet).not.toHaveBeenCalled();
		expect(pushSubscriptionPost).not.toHaveBeenCalled();
	});

	it('upserts the registration when toggling so a missing server entry cannot silently ignore the change', async () => {
		notificationPermission = 'granted';
		getSubscriptionMock.mockResolvedValue(createSubscription());
		const { result } = renderHook(() => usePushNotifications());
		await waitFor(() => expect(result.current.isEnabled).toBe(true));
		pushSubscriptionPost.mockResolvedValue({ ok: true, json: async () => ({ enabled: false }) });
		await act(async () => {
			await result.current.toggleEnabled();
		});
		expect(pushSubscriptionPost).toHaveBeenCalledWith({
			json: { endpoint: 'https://push.example.com/device', key: 'public-key', auth: 'auth-key', enabled: false },
		});
		expect(result.current.isEnabled).toBe(false);
	});

	it('reuses a browser subscription when explicitly enabling after a partial registration failure', async () => {
		getSubscriptionMock.mockResolvedValue(createSubscription());
		requestPermissionMock.mockImplementation(async () => {
			notificationPermission = 'granted';
			return 'granted';
		});
		const { result } = renderHook(() => usePushNotifications());
		await act(async () => {
			await result.current.subscribe();
		});
		expect(result.current.isEnabled).toBe(true);
		expect(subscribeMock).not.toHaveBeenCalled();
		expect(pushSubscriptionPost).toHaveBeenCalledWith({
			json: { endpoint: 'https://push.example.com/device', key: 'public-key', auth: 'auth-key', enabled: true },
		});
	});

	it('updates another open button when the preference changes in a different tab', async () => {
		notificationPermission = 'granted';
		getSubscriptionMock.mockResolvedValue(createSubscription());
		let enabled = true;
		pushNotificationPreferenceGet.mockImplementation(async () => ({ ok: true, json: async () => ({ registered: true, enabled }) }));
		pushSubscriptionPost.mockImplementation(async ({ json }: { json: { enabled: boolean } }) => {
			enabled = json.enabled;
			return { ok: true, json: async () => ({ enabled }) };
		});
		const firstTab = renderHook(() => usePushNotifications());
		render(<NotificationToggle />);
		await waitFor(() => expect(screen.getByRole('button', { name: 'Notifications enabled' })).toBeEnabled());
		await waitFor(() => expect(firstTab.result.current.isEnabled).toBe(true));

		await act(async () => {
			await firstTab.result.current.toggleEnabled();
		});

		await waitFor(() => expect(screen.getByRole('button', { name: 'Notifications disabled' })).toBeEnabled());
		expect(firstTab.result.current.isEnabled).toBe(false);
		expect(pushSubscriptionPost).toHaveBeenCalledOnce();
	});

	it('periodically reconciles external server preference changes while the page is visible', async () => {
		vi.useFakeTimers();
		notificationPermission = 'granted';
		getSubscriptionMock.mockResolvedValue(createSubscription());
		const { result, unmount } = renderHook(() => usePushNotifications());
		await act(async () => {});
		expect(result.current.isEnabled).toBe(true);
		pushNotificationPreferenceGet.mockResolvedValue({ ok: true, json: async () => ({ registered: true, enabled: false }) });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(30_000);
		});
		expect(result.current.isEnabled).toBe(false);
		expect(result.current.isSubscribed).toBe(true);
		unmount();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('checks again on becoming visible and does not poll a hidden page', async () => {
		vi.useFakeTimers();
		notificationPermission = 'granted';
		getSubscriptionMock.mockResolvedValue(createSubscription());
		const { result } = renderHook(() => usePushNotifications());
		await act(async () => {});
		expect(result.current.isEnabled).toBe(true);
		const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
		pushNotificationPreferenceGet.mockClear();
		pushNotificationPreferenceGet.mockResolvedValue({ ok: true, json: async () => ({ registered: true, enabled: false }) });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(pushNotificationPreferenceGet).not.toHaveBeenCalled();
		visibility.mockReturnValue('visible');
		await act(async () => {
			document.dispatchEvent(new Event('visibilitychange'));
		});
		expect(result.current.isEnabled).toBe(false);
	});

	it.each(['controllerchange', 'message'])('reconciles subscription changes signaled by a service worker (%s)', async (eventName) => {
		notificationPermission = 'granted';
		getSubscriptionMock.mockResolvedValue(createSubscription());
		const { result } = renderHook(() => usePushNotifications());
		await waitFor(() => expect(result.current.isEnabled).toBe(true));
		getSubscriptionMock.mockImplementation(async (): Promise<undefined> => {});
		subscribeMock.mockRejectedValue(new Error('Subscription unavailable'));
		await act(async () => {
			serviceWorker.dispatchEvent(
				eventName === 'message' ? new MessageEvent('message', { data: 'push-state-changed' }) : new Event(eventName),
			);
		});
		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(result.current.isSubscribed).toBe(false);
		expect(result.current.isEnabled).toBe(false);
	});

	it('keeps a disabled preference when recovering a replacement browser subscription', async () => {
		notificationPermission = 'granted';
		getSubscriptionMock.mockResolvedValue(createSubscription());
		pushNotificationPreferenceGet.mockResolvedValue({ ok: true, json: async () => ({ registered: true, enabled: false }) });
		const { result } = renderHook(() => usePushNotifications());
		await waitFor(() => expect(result.current.isSubscribed).toBe(true));
		getSubscriptionMock.mockImplementation(async (): Promise<undefined> => {});
		subscribeMock.mockResolvedValue({ ...createSubscription(), endpoint: 'https://push.example.com/replacement' });
		pushSubscriptionPost.mockResolvedValue({ ok: true, json: async () => ({ enabled: false }) });
		await act(async () => {
			serviceWorker.dispatchEvent(new MessageEvent('message', { data: 'push-state-changed' }));
		});
		await waitFor(() => expect(result.current.isSubscribed).toBe(true));
		expect(pushSubscriptionPost).toHaveBeenCalledWith({
			json: { endpoint: 'https://push.example.com/replacement', key: 'public-key', auth: 'auth-key', enabled: false },
		});
		expect(result.current.isEnabled).toBe(false);
	});

	it('clears the enabled button when its server registration disappears and recovery fails', async () => {
		notificationPermission = 'granted';
		getSubscriptionMock.mockResolvedValue(createSubscription());
		render(<NotificationToggle />);
		await waitFor(() => expect(screen.getByRole('button', { name: 'Notifications enabled' })).toBeEnabled());
		pushNotificationPreferenceGet.mockResolvedValue({ ok: true, json: async () => ({ registered: false, enabled: false }) });
		pushSubscriptionPost.mockResolvedValue({ ok: false });
		await act(async () => {
			globalThis.dispatchEvent(new Event('online'));
		});
		await waitFor(() => expect(screen.getByRole('button', { name: 'Enable notifications' })).toBeEnabled());
		expect(subscribeMock).not.toHaveBeenCalled();
	});

	it('rechecks a preference update received during a pending server read', async () => {
		notificationPermission = 'granted';
		getSubscriptionMock.mockResolvedValue(createSubscription());
		let finishPreference: (() => void) | undefined;
		pushNotificationPreferenceGet.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishPreference = () => resolve({ ok: true, json: async () => ({ registered: true, enabled: true }) });
				}),
		);
		const { result } = renderHook(() => usePushNotifications());
		await waitFor(() => expect(pushNotificationPreferenceGet).toHaveBeenCalledOnce());
		pushNotificationPreferenceGet.mockResolvedValue({ ok: true, json: async () => ({ registered: true, enabled: false }) });
		await act(async () => {
			MockBroadcastChannel.instances[0]?.dispatchEvent(new MessageEvent('message', { data: 'push-state-changed' }));
			finishPreference?.();
		});
		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(pushNotificationPreferenceGet).toHaveBeenCalledTimes(2);
		expect(result.current.isSubscribed).toBe(true);
		expect(result.current.isEnabled).toBe(false);
	});

	it('immediately reflects revoked permission during a toggle and ignores its late success', async () => {
		notificationPermission = 'granted';
		getSubscriptionMock.mockResolvedValue(createSubscription());
		pushNotificationPreferenceGet.mockResolvedValue({ ok: true, json: async () => ({ registered: true, enabled: false }) });
		const { result } = renderHook(() => usePushNotifications());
		await waitFor(() => expect(result.current.isSubscribed).toBe(true));
		let finishRegistration: (() => void) | undefined;
		pushSubscriptionPost.mockImplementation(
			() =>
				new Promise((resolve) => {
					finishRegistration = () => resolve({ ok: true, json: async () => ({ enabled: true }) });
				}),
		);
		await act(async () => {
			void result.current.toggleEnabled();
		});
		await waitFor(() => expect(pushSubscriptionPost).toHaveBeenCalledOnce());
		notificationPermission = 'denied';
		await act(async () => {
			permissionChangeListener?.(new Event('change'));
		});
		expect(result.current.permissionState).toBe('denied');
		expect(result.current.isSubscribed).toBe(false);
		expect(result.current.isEnabled).toBe(false);
		await act(async () => {
			finishRegistration?.();
		});
		expect(result.current.isLoading).toBe(false);
		expect(result.current.isSubscribed).toBe(false);
		expect(result.current.isEnabled).toBe(false);
	});
});
