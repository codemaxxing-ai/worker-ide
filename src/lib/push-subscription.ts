const SERVICE_WORKER_READY_TIMEOUT_MS = 10_000;

async function getPushRegistration(): Promise<ServiceWorkerRegistration> {
	const existingRegistration = await navigator.serviceWorker.getRegistration('/');
	const registration =
		existingRegistration ?? (await navigator.serviceWorker.register(import.meta.env.DEV ? '/dev-sw.js?dev-sw' : '/sw.js', { scope: '/' }));
	if (registration.active) return registration;

	// The container's ready promise may still resolve to an unregistered worker.
	return new Promise<ServiceWorkerRegistration>((resolve, reject) => {
		const workers = new Set<ServiceWorker>();
		const cleanup = () => {
			clearTimeout(timeout);
			registration.removeEventListener('updatefound', checkActivation);
			for (const worker of workers) worker.removeEventListener('statechange', checkActivation);
		};
		const checkActivation = () => {
			if (registration.active) {
				cleanup();
				resolve(registration);
				return;
			}
			const worker = registration.installing ?? registration.waiting;
			if (!worker || workers.has(worker)) return;
			workers.add(worker);
			worker.addEventListener('statechange', checkActivation);
		};
		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error('Service worker did not become ready'));
		}, SERVICE_WORKER_READY_TIMEOUT_MS);
		registration.addEventListener('updatefound', checkActivation);
		checkActivation();
	});
}

export async function getPushSubscription(): Promise<PushSubscription | undefined> {
	const registration = await getPushRegistration();
	return (await registration.pushManager.getSubscription()) ?? undefined;
}

export async function acquirePushSubscription(vapidPublicKey: string): Promise<PushSubscription> {
	const registration = await getPushRegistration();
	const existingSubscription = await registration.pushManager.getSubscription();
	if (existingSubscription) return existingSubscription;
	if (Notification.permission !== 'granted') throw new Error('Notification permission is not granted');

	return registration.pushManager.subscribe({
		userVisibleOnly: true,
		applicationServerKey: vapidPublicKey,
	});
}
