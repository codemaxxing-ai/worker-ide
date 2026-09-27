import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useStore } from '@/lib/store';

import { useUnsavedChangesWarning } from './use-unsaved-changes-warning';

describe('useUnsavedChangesWarning', () => {
	beforeEach(() => {
		useStore.setState({ unsavedChanges: new Map() });
	});

	it('prevents unload when any editor file has unsaved changes', () => {
		useStore.getState().markFileChanged('/src/main.ts', true);
		renderHook(() => useUnsavedChangesWarning());

		const event = new Event('beforeunload', { cancelable: true });
		globalThis.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
	});

	it('does not prevent unload when there are no unsaved editor changes', () => {
		renderHook(() => useUnsavedChangesWarning());

		const event = new Event('beforeunload', { cancelable: true });
		globalThis.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(false);
	});
});
