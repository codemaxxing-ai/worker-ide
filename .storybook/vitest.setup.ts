import { vi } from 'vitest';

vi.mock('virtual:pwa-register/react', () => ({
	useRegisterSW: () => ({
		needRefresh: [false, () => {}],
		offlineReady: [false, () => {}],
		updateServiceWorker: () => {},
	}),
}));
