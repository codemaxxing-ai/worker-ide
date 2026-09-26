import { useMemo } from 'react';
import { useDefaultLayout } from 'react-resizable-panels';

import { useStore } from '@/lib/store';

export function usePanelLayouts(projectId: string) {
	const agentPanelVisible = useStore((state) => state.agentPanelVisible);
	const utilityPanelVisible = useStore((state) => state.utilityPanelVisible);
	const devtoolsVisible = useStore((state) => state.devtoolsVisible);
	const dependenciesPanelVisible = useStore((state) => state.dependenciesPanelVisible);

	// Main horizontal layout: sidebar | editor-col | preview-col | agent-panel
	const mainPanelIds = useMemo(() => {
		const ids = ['sidebar', 'editor-col', 'preview-col'];
		if (agentPanelVisible) ids.push('agent-panel');
		return ids;
	}, [agentPanelVisible]);

	const mainLayout = useDefaultLayout({ id: `ide-main-${projectId}`, panelIds: mainPanelIds });

	// Sidebar panels: file-tree | dependencies
	const sidebarPanelIds = useMemo(() => {
		const ids = ['file-tree'];
		if (dependenciesPanelVisible) ids.push('dependencies');
		return ids;
	}, [dependenciesPanelVisible]);

	const sidebarLayout = useDefaultLayout({ id: `sidebar-panels-${projectId}`, panelIds: sidebarPanelIds });

	// Editor + terminal: editor | utility-panel
	const editorTerminalPanelIds = useMemo(() => {
		const ids = ['editor'];
		if (utilityPanelVisible) ids.push('utility-panel');
		return ids;
	}, [utilityPanelVisible]);

	const editorTerminalLayout = useDefaultLayout({ id: `ide-editor-terminal-${projectId}`, panelIds: editorTerminalPanelIds });

	// Preview + devtools: preview | devtools
	const previewDevtoolsPanelIds = useMemo(() => {
		const ids = ['preview'];
		if (devtoolsVisible) ids.push('devtools');
		return ids;
	}, [devtoolsVisible]);

	const previewDevtoolsLayout = useDefaultLayout({ id: `ide-preview-devtools-${projectId}`, panelIds: previewDevtoolsPanelIds });

	return {
		agentPanelVisible,
		utilityPanelVisible,
		devtoolsVisible,
		dependenciesPanelVisible,
		mainLayout,
		sidebarLayout,
		editorTerminalLayout,
		previewDevtoolsLayout,
	};
}
