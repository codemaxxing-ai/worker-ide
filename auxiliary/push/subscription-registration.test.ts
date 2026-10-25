import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
	WorkerEntrypoint: class {
		protected env: unknown;
		constructor(_context: unknown, environment: unknown) {
			this.env = environment;
		}
	},
}));

const { default: PushWorker } = await import('./index');

function createWorker() {
	const subscriptions = new Map<string, string>();
	const environment = {
		KV_PUSH_SUBSCRIPTION: {
			get: vi.fn(async (key: string) => subscriptions.get(key)),
			put: vi.fn(async (key: string, value: string) => {
				subscriptions.set(key, value);
			}),
			delete: vi.fn(async (key: string) => {
				subscriptions.delete(key);
			}),
		},
	};
	const context = { waitUntil: vi.fn(), passThroughOnException: vi.fn(), exports: {}, props: {} };
	return { worker: new PushWorker(context, environment), environment, subscriptions };
}

const subscription = { endpoint: 'https://push.example.com/device', key: 'public-key', auth: 'auth-key' };

describe('push registration recovery', () => {
	it('restores a missing registration and enables it by default', async () => {
		const { worker } = createWorker();
		expect(await worker.getNotificationPreference('user', subscription.endpoint)).toBeUndefined();
		expect(await worker.registerSubscription('user', subscription)).toEqual({ enabled: true });
		expect(await worker.getNotificationPreference('user', subscription.endpoint)).toEqual({ enabled: true });
	});

	it('preserves disabled preferences when the browser registers again', async () => {
		const { worker, subscriptions } = createWorker();
		await worker.registerSubscription('user', subscription);
		await worker.setNotificationPreference('user', subscription.endpoint, false);
		expect(await worker.registerSubscription('user', { ...subscription, auth: 'refreshed-auth' })).toEqual({ enabled: false });
		expect(await worker.getNotificationPreference('user', subscription.endpoint)).toEqual({ enabled: false });
		expect([...subscriptions.values()].map((value) => JSON.parse(value))).toEqual([
			{ ...subscription, auth: 'refreshed-auth', notificationsEnabled: false },
		]);
	});

	it('allows an explicit user action to enable a disabled registration', async () => {
		const { worker } = createWorker();
		await worker.registerSubscription('user', { ...subscription, notificationsEnabled: false });
		expect(await worker.registerSubscription('user', { ...subscription, notificationsEnabled: true })).toEqual({ enabled: true });
	});

	it('keeps registrations and preferences scoped to the authenticated user', async () => {
		const { worker } = createWorker();
		await worker.registerSubscription('first-user', { ...subscription, notificationsEnabled: false });
		expect(await worker.getNotificationPreference('second-user', subscription.endpoint)).toBeUndefined();
		expect(await worker.registerSubscription('second-user', subscription)).toEqual({ enabled: true });
		expect(await worker.getNotificationPreference('first-user', subscription.endpoint)).toEqual({ enabled: false });
	});

	it.each(['invalid-json', '{}', 'false', '{"endpoint":"device","key":1,"auth":"auth"}'])(
		'repairs invalid stored registrations: %s',
		async (stored) => {
			const { worker, subscriptions } = createWorker();
			await worker.registerSubscription('user', subscription);
			for (const key of subscriptions.keys()) subscriptions.set(key, stored);
			expect(await worker.getNotificationPreference('user', subscription.endpoint)).toBeUndefined();
			await worker.registerSubscription('user', subscription);
			expect(await worker.getNotificationPreference('user', subscription.endpoint)).toEqual({ enabled: true });
		},
	);

	it('accepts legacy registrations without a preference flag', async () => {
		const { worker, subscriptions } = createWorker();
		await worker.registerSubscription('user', subscription);
		for (const key of subscriptions.keys()) subscriptions.set(key, JSON.stringify(subscription));
		expect(await worker.getNotificationPreference('user', subscription.endpoint)).toEqual({ enabled: true });
	});
});
