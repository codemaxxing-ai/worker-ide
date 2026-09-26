import { useEffect } from 'react';

import { useStore } from '@/lib/store';

export function useUnsavedChangesWarning() {
	const hasUnsavedChanges = useStore((state) => {
		for (const changed of state.unsavedChanges.values()) {
			if (changed) {
				return true;
			}
		}

		return false;
	});

	useEffect(() => {
		if (!hasUnsavedChanges) {
			return;
		}

		const handleBeforeUnload = (event: BeforeUnloadEvent) => {
			event.preventDefault();
		};

		globalThis.addEventListener('beforeunload', handleBeforeUnload);
		return () => {
			globalThis.removeEventListener('beforeunload', handleBeforeUnload);
		};
	}, [hasUnsavedChanges]);
}
