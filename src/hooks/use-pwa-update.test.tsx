import { act, cleanup, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
	clearUpdateActivationReloadPendingMock,
	markUpdateActivationReloadPendingMock,
	recoverFromStaleAssetMock,
	toastInfoMock,
	updateServiceWorkerMock,
	useRegisterSWMock,
} = vi.hoisted(() => ({
	clearUpdateActivationReloadPendingMock: vi.fn(),
	markUpdateActivationReloadPendingMock: vi.fn(),
	recoverFromStaleAssetMock: vi.fn(),
	toastInfoMock: vi.fn(),
	updateServiceWorkerMock: vi.fn<(reloadPage?: boolean) => Promise<void>>(),
	useRegisterSWMock: vi.fn(),
}));

vi.mock('@/components/ui/toast-store', () => ({
	toast: {
		info: toastInfoMock,
	},
}));

vi.mock('@/lib/stale-asset-recovery', () => ({
	clearUpdateActivationReloadPending: clearUpdateActivationReloadPendingMock,
	markUpdateActivationReloadPending: markUpdateActivationReloadPendingMock,
	recoverFromStaleAsset: recoverFromStaleAssetMock,
}));

vi.mock('@/lib/pwa-register', () => ({
	useRegisterSW: useRegisterSWMock,
}));

interface MockServiceWorkerRegistration {
	update: () => Promise<void>;
	installing: undefined;
}

interface RegisterSWOptions {
	onRegisteredSW?: (swUrl: string, registration?: MockServiceWorkerRegistration) => void;
}

describe('usePwaUpdate', () => {
	const originalServiceWorker = navigator.serviceWorker;
	let controllerChangeListener: EventListener | undefined;
	let registrationUpdateMock: ReturnType<typeof vi.fn>;
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.resetModules();
		vi.useFakeTimers();
		toastInfoMock.mockReset();
		markUpdateActivationReloadPendingMock.mockReset();
		clearUpdateActivationReloadPendingMock.mockReset();
		recoverFromStaleAssetMock.mockReset();
		updateServiceWorkerMock.mockReset();
		updateServiceWorkerMock.mockResolvedValue();
		registrationUpdateMock = vi.fn(async () => {});
		fetchMock = vi.fn(async () => new Response(undefined, { status: 200 }));
		controllerChangeListener = undefined;
		vi.stubGlobal('fetch', fetchMock);

		Object.defineProperty(navigator, 'serviceWorker', {
			configurable: true,
			value: {
				addEventListener: vi.fn((eventName: string, listener: EventListenerOrEventListenerObject) => {
					if (eventName === 'controllerchange' && typeof listener === 'function') {
						controllerChangeListener = listener;
					}
				}),
				removeEventListener: vi.fn(),
			},
		});

		useRegisterSWMock.mockImplementation((options?: RegisterSWOptions) => {
			options?.onRegisteredSW?.('/sw.js', {
				update: registrationUpdateMock,
				installing: undefined,
			});

			return {
				needRefresh: [false, vi.fn()],
				updateServiceWorker: updateServiceWorkerMock,
			};
		});
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.unstubAllGlobals();
		Object.defineProperty(navigator, 'serviceWorker', {
			configurable: true,
			value: originalServiceWorker,
		});
	});

	it('prompts for a startup update without automatically activating or reloading', async () => {
		useRegisterSWMock.mockImplementationOnce((options?: RegisterSWOptions) => {
			options?.onRegisteredSW?.('/sw.js', {
				update: registrationUpdateMock,
				installing: undefined,
			});

			return {
				needRefresh: [true, vi.fn()],
				updateServiceWorker: updateServiceWorkerMock,
			};
		});

		const { usePwaUpdate } = await import('./use-pwa-update');
		renderHook(() => usePwaUpdate());

		expect(updateServiceWorkerMock).not.toHaveBeenCalled();
		expect(markUpdateActivationReloadPendingMock).not.toHaveBeenCalled();
		expect(toastInfoMock).toHaveBeenCalledTimes(1);
		expect(registrationUpdateMock).toHaveBeenCalledTimes(1);

		await act(async () => {
			controllerChangeListener?.(new Event('controllerchange'));
		});

		expect(recoverFromStaleAssetMock).not.toHaveBeenCalled();
	});

	it('prompts immediately when an update arrives and delegates one reload to the PWA plugin', async () => {
		useRegisterSWMock.mockImplementationOnce((options?: RegisterSWOptions) => {
			options?.onRegisteredSW?.('/sw.js', {
				update: registrationUpdateMock,
				installing: undefined,
			});

			return {
				needRefresh: [false, vi.fn()],
				updateServiceWorker: updateServiceWorkerMock,
			};
		});

		const { usePwaUpdate } = await import('./use-pwa-update');
		const { rerender } = renderHook(() => usePwaUpdate());

		useRegisterSWMock.mockImplementation((options?: RegisterSWOptions) => {
			options?.onRegisteredSW?.('/sw.js', {
				update: registrationUpdateMock,
				installing: undefined,
			});

			return {
				needRefresh: [true, vi.fn()],
				updateServiceWorker: updateServiceWorkerMock,
			};
		});

		rerender();
		rerender();

		expect(toastInfoMock).toHaveBeenCalledTimes(1);
		expect(updateServiceWorkerMock).not.toHaveBeenCalled();
		const toastCall = toastInfoMock.mock.calls[0];
		expect(toastCall).toBeDefined();
		if (!toastCall) {
			throw new Error('Expected toast call to be defined');
		}

		const toastOptions = toastCall[1];
		expect(toastCall[0]).toBe('New version available');
		expect(toastOptions).toMatchObject({ persist: true });
		expect(toastOptions?.action).toBeDefined();
		if (!toastOptions?.action) {
			throw new Error('Expected toast action to be defined');
		}

		await act(async () => {
			toastOptions.action.onClick();
			toastOptions.action.onClick();
		});

		expect(updateServiceWorkerMock).toHaveBeenCalledExactlyOnceWith(true);
		expect(markUpdateActivationReloadPendingMock).toHaveBeenCalledTimes(1);

		await act(async () => {
			controllerChangeListener?.(new Event('controllerchange'));
		});

		expect(recoverFromStaleAssetMock).not.toHaveBeenCalled();
	});

	it('does not duplicate a startup update prompt in Strict Mode', async () => {
		useRegisterSWMock.mockReturnValue({
			needRefresh: [true, vi.fn()],
			updateServiceWorker: updateServiceWorkerMock,
		});
		const { usePwaUpdate } = await import('./use-pwa-update');
		renderHook(() => usePwaUpdate(), { wrapper: StrictMode });
		expect(toastInfoMock).toHaveBeenCalledOnce();
		expect(updateServiceWorkerMock).not.toHaveBeenCalled();
	});

	it('allows retrying a failed activation without leaving recovery suppressed', async () => {
		useRegisterSWMock.mockReturnValue({
			needRefresh: [true, vi.fn()],
			updateServiceWorker: updateServiceWorkerMock,
		});
		updateServiceWorkerMock.mockRejectedValueOnce(new Error('Unavailable'));
		const { usePwaUpdate } = await import('./use-pwa-update');
		renderHook(() => usePwaUpdate());
		const reloadAction = toastInfoMock.mock.calls[0]?.[1]?.action?.onClick;
		if (!reloadAction) throw new Error('Expected a reload action');
		await act(async () => reloadAction());
		expect(clearUpdateActivationReloadPendingMock).toHaveBeenCalledOnce();
		await act(async () => reloadAction());
		expect(updateServiceWorkerMock).toHaveBeenCalledTimes(2);
	});

	it('stops polling and ignores update actions after unmount', async () => {
		useRegisterSWMock.mockImplementationOnce((options?: RegisterSWOptions) => {
			options?.onRegisteredSW?.('/sw.js', {
				update: registrationUpdateMock,
				installing: undefined,
			});
			return {
				needRefresh: [true, vi.fn()],
				updateServiceWorker: updateServiceWorkerMock,
			};
		});
		const { usePwaUpdate } = await import('./use-pwa-update');
		const { unmount } = renderHook(() => usePwaUpdate());
		const reloadAction = toastInfoMock.mock.calls[0]?.[1]?.action?.onClick;
		if (!reloadAction) throw new Error('Expected a reload action');
		expect(registrationUpdateMock).toHaveBeenCalledOnce();
		unmount();
		reloadAction();
		await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(updateServiceWorkerMock).not.toHaveBeenCalled();
	});

	it('keeps polling after a failed initial update check', async () => {
		registrationUpdateMock.mockRejectedValueOnce(new Error('Unavailable'));
		const { usePwaUpdate } = await import('./use-pwa-update');
		renderHook(() => usePwaUpdate());
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
		});
		expect(registrationUpdateMock).toHaveBeenCalledTimes(2);
	});

	it('ignores service worker polling fetch failures', async () => {
		const rejectionError = new Error('Network unavailable');
		fetchMock.mockRejectedValue(rejectionError);

		const { usePwaUpdate } = await import('./use-pwa-update');
		renderHook(() => usePwaUpdate());

		expect(registrationUpdateMock).toHaveBeenCalledTimes(1);

		await act(async () => {
			vi.advanceTimersByTime(5 * 60 * 1000);
			await Promise.resolve();
		});

		expect(fetchMock).toHaveBeenCalledWith('/sw.js', {
			cache: 'no-store',
			headers: { cache: 'no-store' },
		});
		expect(registrationUpdateMock).toHaveBeenCalledTimes(1);
	});
});
