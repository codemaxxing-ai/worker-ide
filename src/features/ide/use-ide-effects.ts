import { useEffect, useRef } from 'react';

import { getDependencyErrorCount, subscribeDependencyErrors } from '@/features/file-tree/dependency-error-store';
import { useGitStatusBackgroundLoader } from '@/features/git/index';
import { isMessageFromPreview } from '@/lib/preview-origin';
import { useProjectDeepLinkApplier } from '@/lib/project-deep-link';
import { useStore } from '@/lib/store';
import { isProjectDeepLinkTarget } from '@shared/project-deep-link';

import { useUnsavedChangesWarning } from './use-unsaved-changes-warning';

import type { RefObject } from 'react';

interface UseIDEEffectsOptions {
	projectId: string;
	previewOrigin: string | undefined;
	handleSaveReference: RefObject<() => Promise<void>>;
	cursorUpdateTimeoutReference: RefObject<ReturnType<typeof setTimeout> | undefined>;
}

export function useIDEEffects({ projectId, previewOrigin, handleSaveReference, cursorUpdateTimeoutReference }: UseIDEEffectsOptions) {
	useUnsavedChangesWarning();
	const applyProjectDeepLink = useProjectDeepLinkApplier();

	// Always load git status in the background so file tree decorations stay
	// accurate regardless of which sidebar view is active. Non-blocking: the app
	// stays interactive while the request is in flight.
	useGitStatusBackgroundLoader({ projectId });

	// Auto-expand dependencies panel when new errors are detected.
	const showDependenciesPanel = useStore((state) => state.showDependenciesPanel);
	const previousDependencyErrorCount = useRef(0);
	useEffect(() => {
		return subscribeDependencyErrors(() => {
			const currentCount = getDependencyErrorCount();
			if (currentCount > previousDependencyErrorCount.current) {
				showDependenciesPanel();
			}
			previousDependencyErrorCount.current = currentCount;
		});
	}, [showDependenciesPanel]);

	// Listen for canonical deep-link messages from preview surfaces.
	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			if (!previewOrigin || !isMessageFromPreview(event)) {
				return;
			}
			if (event.data?.type !== '__deep-link' || !isProjectDeepLinkTarget(event.data.target)) {
				return;
			}

			applyProjectDeepLink(event.data.target);
		};

		globalThis.addEventListener('message', handleMessage);
		return () => globalThis.removeEventListener('message', handleMessage);
	}, [applyProjectDeepLink, previewOrigin]);

	// Keyboard shortcuts
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if ((event.ctrlKey || event.metaKey) && event.key === 's') {
				event.preventDefault();
				void handleSaveReference.current();
			}
		};

		globalThis.addEventListener('keydown', handleKeyDown);
		return () => globalThis.removeEventListener('keydown', handleKeyDown);
	}, [handleSaveReference]);

	// Clean up cursor debounce timeout on unmount
	useEffect(() => {
		const timeoutId = cursorUpdateTimeoutReference.current;
		return () => {
			clearTimeout(timeoutId);
		};
	});
}
