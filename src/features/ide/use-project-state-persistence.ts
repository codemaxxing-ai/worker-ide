import { useEffect, useRef } from 'react';

import { loadProjectUI, saveProjectUI } from '@/lib/project-storage';
import { useStore } from '@/lib/store';

import type { ProjectUIState } from '@/lib/project-storage';

const SAVE_DEBOUNCE_MS = 500;

function readUIStateFromStore(): ProjectUIState {
	const state = useStore.getState();
	return {
		sidebarVisible: state.sidebarVisible,
		utilityPanelVisible: state.utilityPanelVisible,
		agentPanelVisible: state.agentPanelVisible,
		devtoolsVisible: state.devtoolsVisible,
		dependenciesPanelVisible: state.dependenciesPanelVisible,
		activeMobilePanel: state.activeMobilePanel,
		activeSidebarView: state.activeSidebarView,
		activeUtilityTab: state.activeUtilityTab,
		expandedDirs: [...state.expandedDirs],
		selectedModel: state.selectedModel,
	};
}

/**
 * Load per-project UI state into the Zustand store on mount, and persist
 * changes back to the single project key whenever relevant store fields change.
 */
export function useProjectStatePersistence({ projectId }: { projectId: string }) {
	const hasRestoredReference = useRef(false);

	// ── Restore on mount ─────────────────────────────────────────────
	useEffect(() => {
		if (hasRestoredReference.current) return;
		hasRestoredReference.current = true;

		const ui = loadProjectUI(projectId);
		useStore.setState({
			sidebarVisible: ui.sidebarVisible,
			utilityPanelVisible: ui.utilityPanelVisible,
			agentPanelVisible: ui.agentPanelVisible,
			devtoolsVisible: ui.devtoolsVisible,
			dependenciesPanelVisible: ui.dependenciesPanelVisible,
			activeMobilePanel: ui.activeMobilePanel,
			activeSidebarView: ui.activeSidebarView,
			activeUtilityTab: ui.activeUtilityTab,
			expandedDirs: new Set(ui.expandedDirs),
			selectedModel: ui.selectedModel,
		});

		return () => {
			hasRestoredReference.current = false;
		};
	}, [projectId]);

	// ── Persist on change (debounced) ────────────────────────────────
	const saveTimeoutReference = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	useEffect(() => {
		const unsubscribe = useStore.subscribe((state, previousState) => {
			const changed =
				state.sidebarVisible !== previousState.sidebarVisible ||
				state.utilityPanelVisible !== previousState.utilityPanelVisible ||
				state.agentPanelVisible !== previousState.agentPanelVisible ||
				state.devtoolsVisible !== previousState.devtoolsVisible ||
				state.dependenciesPanelVisible !== previousState.dependenciesPanelVisible ||
				state.activeMobilePanel !== previousState.activeMobilePanel ||
				state.activeSidebarView !== previousState.activeSidebarView ||
				state.activeUtilityTab !== previousState.activeUtilityTab ||
				state.expandedDirs !== previousState.expandedDirs ||
				state.selectedModel !== previousState.selectedModel;

			if (!changed) return;

			clearTimeout(saveTimeoutReference.current);
			saveTimeoutReference.current = setTimeout(() => {
				saveProjectUI(projectId, readUIStateFromStore());
			}, SAVE_DEBOUNCE_MS);
		});

		return () => {
			unsubscribe();
			clearTimeout(saveTimeoutReference.current);
			// Flush on unmount
			saveProjectUI(projectId, readUIStateFromStore());
		};
	}, [projectId]);
}
