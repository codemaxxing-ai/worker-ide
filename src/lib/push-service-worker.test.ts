import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

interface TestPushEvent {
	data?: { json: () => unknown; text: () => string };
	notification?: { close: () => void; data: unknown };
	waitUntil: (promise: Promise<unknown>) => void;
}

function createServiceWorker() {
	const handlers = new Map<string, (event: TestPushEvent) => void>();
	const showNotification = vi.fn(async () => {});
	const client = { navigate: vi.fn(async () => {}), focus: vi.fn(async () => {}), postMessage: vi.fn() };
	const clients = { matchAll: vi.fn(async () => [client]), openWindow: vi.fn(async () => {}) };
	runInNewContext(readFileSync(new URL('../../public/push-sw.js', import.meta.url), 'utf8'), {
		URL,
		location: { origin: 'https://codemaxxing.app' },
		registration: { showNotification },
		clients,
		addEventListener: (name: string, handler: (event: TestPushEvent) => void) => {
			handlers.set(name, handler);
		},
	});
	return { handlers, showNotification, clients, client };
}

describe('push service worker', () => {
	it('tells open pages to reconcile a changed browser subscription', async () => {
		const { handlers, client, clients } = createServiceWorker();
		const pending: Promise<unknown>[] = [];
		handlers.get('pushsubscriptionchange')?.({
			waitUntil: (promise) => {
				pending.push(promise);
			},
		});
		await Promise.all(pending);
		expect(clients.matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true });
		expect(client.postMessage).toHaveBeenCalledWith('push-state-changed');
	});

	it('displays the delivered notification and preserves its session deep link', async () => {
		const { handlers, showNotification } = createServiceWorker();
		const deepLink = { projectId: 'project', target: { kind: 'agent-session', sessionId: 'session' } };
		const pending: Promise<unknown>[] = [];
		handlers.get('push')?.({
			data: { json: () => ({ title: 'Agent needs input', body: 'Choose an option', tag: 'session', deepLink }), text: () => '' },
			waitUntil: (promise) => {
				pending.push(promise);
			},
		});
		await Promise.all(pending);
		expect(showNotification).toHaveBeenCalledWith('Agent needs input', {
			body: 'Choose an option',
			tag: 'session',
			icon: '/favicon.svg',
			badge: '/favicon.svg',
			data: { path: undefined, deepLink },
		});
	});

	it('opens the correct session in an existing window when clicked', async () => {
		const { handlers, client } = createServiceWorker();
		const close = vi.fn();
		const pending: Promise<unknown>[] = [];
		handlers.get('notificationclick')?.({
			notification: { close, data: { deepLink: { projectId: 'project', target: { kind: 'agent-session', sessionId: 'session' } } } },
			waitUntil: (promise) => {
				pending.push(promise);
			},
		});
		await Promise.all(pending);
		expect(close).toHaveBeenCalledOnce();
		expect(client.navigate).toHaveBeenCalledWith('https://codemaxxing.app/p/project?session=session');
		expect(client.focus).toHaveBeenCalledOnce();
	});

	it('opens a window when a notification arrives while the app is closed', async () => {
		const { handlers, clients } = createServiceWorker();
		clients.matchAll.mockResolvedValue([]);
		const pending: Promise<unknown>[] = [];
		handlers.get('notificationclick')?.({
			notification: { close: vi.fn(), data: { path: '/p/project?session=session' } },
			waitUntil: (promise) => {
				pending.push(promise);
			},
		});
		await Promise.all(pending);
		expect(clients.openWindow).toHaveBeenCalledWith('https://codemaxxing.app/p/project?session=session');
	});
});
