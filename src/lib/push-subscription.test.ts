import { afterEach, describe, expect, it, vi } from 'vitest';

import { acquirePushSubscription, getPushSubscription } from './push-subscription';

function mockServiceWorker(active = true) {
	const subscription = { endpoint: 'https://push.example.com/device' };
	const registration = Object.assign(new EventTarget(), {
		active: active ? {} : undefined,
		installing: new EventTarget(),
		pushManager: {
			getSubscription: vi.fn(async (): Promise<typeof subscription | undefined> => subscription),
			subscribe: vi.fn(async () => subscription),
		},
	});
	const serviceWorker = {
		getRegistration: vi.fn(async (): Promise<typeof registration | undefined> => registration),
		register: vi.fn(async () => registration),
		ready: Promise.resolve(registration),
	};
	vi.stubGlobal('navigator', { serviceWorker });
	vi.stubGlobal('Notification', { permission: 'granted' });
	return { serviceWorker, registration, subscription };
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('push subscription acquisition', () => {
	it('uses an active service worker without waiting for the page ready promise', async () => {
		const { serviceWorker, subscription } = mockServiceWorker();
		serviceWorker.ready = new Promise(() => {});
		expect(await getPushSubscription()).toBe(subscription);
		expect(serviceWorker.register).not.toHaveBeenCalled();
	});

	it('registers the application service worker if its registration is missing', async () => {
		const { serviceWorker, subscription } = mockServiceWorker();
		serviceWorker.getRegistration.mockImplementation(async (): Promise<undefined> => {});
		expect(await getPushSubscription()).toBe(subscription);
		expect(serviceWorker.register).toHaveBeenCalledWith('/dev-sw.js?dev-sw', { scope: '/' });
	});

	it('reuses an existing subscription instead of subscribing again', async () => {
		const { registration, subscription } = mockServiceWorker();
		expect(await acquirePushSubscription('public-key')).toBe(subscription);
		expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
	});

	it('waits for the replacement registration even when the container ready promise has already resolved', async () => {
		vi.useFakeTimers();
		const { serviceWorker, registration, subscription } = mockServiceWorker(false);
		serviceWorker.getRegistration.mockImplementation(async (): Promise<undefined> => {});
		const result = getPushSubscription();
		await vi.advanceTimersByTimeAsync(0);
		expect(serviceWorker.register).toHaveBeenCalledOnce();
		expect(registration.pushManager.getSubscription).not.toHaveBeenCalled();
		registration.active = {};
		registration.installing.dispatchEvent(new Event('statechange'));
		expect(await result).toBe(subscription);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('creates a missing browser subscription with the current VAPID key', async () => {
		const { registration, subscription } = mockServiceWorker();
		registration.pushManager.getSubscription.mockImplementation(async (): Promise<undefined> => {});
		expect(await acquirePushSubscription('public-key')).toBe(subscription);
		expect(registration.pushManager.subscribe).toHaveBeenCalledWith({
			userVisibleOnly: true,
			applicationServerKey: 'public-key',
		});
	});

	it('reports activation timeouts so the UI can retry instead of staying busy forever', async () => {
		vi.useFakeTimers();
		const { serviceWorker } = mockServiceWorker(false);
		serviceWorker.ready = new Promise(() => {});
		const result = expect(getPushSubscription()).rejects.toThrow('Service worker did not become ready');
		await vi.advanceTimersByTimeAsync(10_000);
		await result;
		expect(vi.getTimerCount()).toBe(0);
	});

	it('does not create a subscription if permission changes while acquiring it', async () => {
		const { registration } = mockServiceWorker();
		registration.pushManager.getSubscription.mockImplementation(async (): Promise<undefined> => {});
		vi.stubGlobal('Notification', { permission: 'default' });
		await expect(acquirePushSubscription('public-key')).rejects.toThrow('Notification permission is not granted');
		expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
	});

	it('propagates service worker registration failures for a later retry', async () => {
		const { serviceWorker } = mockServiceWorker();
		serviceWorker.getRegistration.mockImplementation(async (): Promise<undefined> => {});
		serviceWorker.register.mockRejectedValue(new Error('Offline'));
		await expect(getPushSubscription()).rejects.toThrow('Offline');
	});
});
