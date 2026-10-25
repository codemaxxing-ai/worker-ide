// Handle incoming push notifications

globalThis.addEventListener('pushsubscriptionchange', (event) => {
	event.waitUntil(
		globalThis.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
			for (const client of clientList) client.postMessage('push-state-changed');
		}),
	);
});

function buildDeepLinkPath(deepLink) {
	if (!deepLink?.projectId || !deepLink?.target) return undefined;

	var target = deepLink.target;
	var url = new globalThis.URL('/p/' + deepLink.projectId, globalThis.location.origin);
	if (target.kind === 'agent-session') {
		url.searchParams.set('session', target.sessionId);
		return url.pathname + url.search;
	}

	if (target.kind === 'panel') {
		url.searchParams.set('panel', target.panel);
		return url.pathname + url.search;
	}

	url.searchParams.set('file', target.file.path);
	if (target.file.line !== undefined) {
		url.searchParams.set('line', String(target.file.line));
		if (target.file.column !== undefined) {
			url.searchParams.set('column', String(target.file.column));
		}
	}

	return url.pathname + url.search;
}

globalThis.addEventListener('push', (event) => {
	if (!event.data) return;

	let payload;
	try {
		payload = event.data.json();
	} catch {
		payload = { title: 'Codemaxxing', body: event.data.text() };
	}

	const { title = 'Codemaxxing', body = '', tag, path, deepLink } = payload;

	event.waitUntil(
		globalThis.registration.showNotification(title, {
			body,
			tag: tag || undefined,
			icon: '/favicon.svg',
			badge: '/favicon.svg',
			data: { path, deepLink },
		}),
	);
});

// Handle notification click — navigate to the relevant project
globalThis.addEventListener('notificationclick', (event) => {
	event.notification.close();

	const path = buildDeepLinkPath(event.notification.data?.deepLink) || event.notification.data?.path || '/';
	const targetUrl = new globalThis.URL(path, globalThis.location.origin).toString();

	event.waitUntil(
		globalThis.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
			// If a window is already open, navigate it to the deep link and focus it.
			for (const client of clientList) {
				if ('navigate' in client && 'focus' in client) {
					return client.navigate(targetUrl).then(() => client.focus());
				}
			}
			// Otherwise open a new window
			if (globalThis.clients.openWindow) {
				return globalThis.clients.openWindow(targetUrl);
			}
		}),
	);
});
