import { useCallback, useEffect, useRef } from 'react';

import { toast } from '@/components/ui/toast-store';
import { useRegisterSW } from '@/lib/pwa-register';
import { clearUpdateActivationReloadPending, markUpdateActivationReloadPending } from '@/lib/stale-asset-recovery';

export function usePwaUpdate() {
	const updateIntervalReference = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
	const isMountedReference = useRef(true);
	const isActivationRequestedReference = useRef(false);
	const hasNotifiedUpdateReference = useRef(false);

	const {
		needRefresh: [needRefresh],
		updateServiceWorker,
	} = useRegisterSW({
		onRegisteredSW(_swUrl, registration) {
			if (registration && isMountedReference.current) {
				void registration.update().catch(() => {});
				const intervalMs = 5 * 60 * 1000;
				clearInterval(updateIntervalReference.current);
				updateIntervalReference.current = setInterval(async () => {
					if (registration.installing || !navigator.onLine) return;

					try {
						const response = await fetch(_swUrl, {
							cache: 'no-store',
							headers: { cache: 'no-store' },
						});

						if (!response.ok) {
							return;
						}

						await registration.update();
					} catch {
						return;
					}
				}, intervalMs);
			}
		},
	});

	const activateUpdate = useCallback(() => {
		if (!isMountedReference.current || isActivationRequestedReference.current) return;
		isActivationRequestedReference.current = true;
		markUpdateActivationReloadPending();
		void updateServiceWorker(true).catch(() => {
			isActivationRequestedReference.current = false;
			clearUpdateActivationReloadPending();
		});
	}, [updateServiceWorker]);

	useEffect(() => {
		isMountedReference.current = true;
		return () => {
			isMountedReference.current = false;
			clearInterval(updateIntervalReference.current);
		};
	}, []);

	useEffect(() => {
		if (!needRefresh) {
			hasNotifiedUpdateReference.current = false;
			return;
		}
		if (hasNotifiedUpdateReference.current) return;
		hasNotifiedUpdateReference.current = true;

		toast.info('New version available', {
			persist: true,
			action: {
				label: 'Reload',
				onClick: activateUpdate,
			},
		});
	}, [activateUpdate, needRefresh]);
}
