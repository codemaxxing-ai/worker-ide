import { useCallback, useEffect, useRef, useState } from 'react';

import { ProjectAccessRestricted } from '@/components/project-access-restricted';
import { ProjectNotFound } from '@/components/project-not-found';
import { toast } from '@/components/ui/toast-store';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AgentRuntimeProvider } from '@/features/agent/index';
import { DeployModal } from '@/features/deploy/index';
import { useFileTree } from '@/features/file-tree/index';
import { setActiveLogProject } from '@/features/output/index';
import { ProjectSettingsModal } from '@/features/project-settings/index';
import { useIsMobile, useProjectSocket, useResolvedTheme } from '@/hooks/index';
import { useQueuedSaveFlusher } from '@/hooks/use-queued-save-flusher';
import { downloadProject } from '@/lib/api-client';
import { usePreviewUrl } from '@/lib/preview-origin';
import { selectIsProcessing, useStore } from '@/lib/store';

import { DesktopLayout } from './desktop-layout';
import { IDEHeader } from './ide-header';
import { MobileLayout } from './mobile-layout';
import { ProjectDeepLinkHandler } from './project-deep-link-handler';
import { useEditorSessionPersistence } from './use-editor-session-persistence';
import { useEditorState } from './use-editor-state';
import { useIDEEffects } from './use-ide-effects';
import { useLogCounts } from './use-log-counts';
import { usePanelLayouts } from './use-panel-layouts';
import { useProjectDataPrefetch } from './use-project-data-prefetch';
import { useProjectName } from './use-project-name';
import { useProjectStatePersistence } from './use-project-state-persistence';

import type { ProjectDeepLinkTarget } from '@shared/project-deep-link';

export function IDEShell({
	projectId,
	initialProjectDeepLink,
	onInitialProjectDeepLinkHandled,
}: {
	projectId: string;
	initialProjectDeepLink?: ProjectDeepLinkTarget;
	onInitialProjectDeepLinkHandled?: () => void;
}) {
	// Restore per-project UI/panel state (sidebar, devtools, expanded dirs, etc.)
	// Must run before other hooks so the store is populated before the first render
	useProjectStatePersistence({ projectId });

	// Restore and persist editor session (open tabs, active file, cursor/scroll positions)
	useEditorSessionPersistence({ projectId });
	useProjectDataPrefetch(projectId);
	useQueuedSaveFlusher(projectId);

	// Project WebSocket connection (HMR notifications, collaboration, server events)
	useProjectSocket({ projectId });

	// Reset the process-global output log buffer when switching projects so the
	// previous project's console/server logs don't leak into this project's panel.
	useEffect(() => {
		setActiveLogProject(projectId);
	}, [projectId]);

	// Theme (still needed for editor/terminal theming in Desktop/Mobile layouts)
	const resolvedTheme = useResolvedTheme();

	// Mobile layout
	const isMobile = useIsMobile();
	const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

	// Deploy modal
	const [deployModalOpen, setDeployModalOpen] = useState(false);

	// Project settings modal
	const [settingsModalOpen, setSettingsModalOpen] = useState(false);
	const [projectAvailabilityState, setProjectAvailabilityState] = useState<{
		projectId: string;
		status: 'available' | 'not-found' | 'forbidden';
	}>({ projectId, status: 'available' });

	// Agent panel toggle
	const toggleAgentPanel = useStore((state) => state.toggleAgentPanel);
	const isAgentProcessing = useStore(selectIsProcessing);

	// Custom hooks
	const projectNameState = useProjectName({ projectId });
	const logCounts = useLogCounts();
	const editorState = useEditorState({ projectId });
	const layouts = usePanelLayouts(projectId);

	// Shared preview iframe ref for CDP message relay with DevTools
	const previewIframeReference = useRef<HTMLIFrameElement>(null);

	// File tree hook
	const fileTree = useFileTree({ projectId });

	// Signed preview URL (HMAC time-bucket token)
	const { previewUrl, previewOrigin, isLoading: isLoadingPreviewUrl, refresh: refreshPreviewUrl } = usePreviewUrl(projectId);
	const projectAvailability = projectAvailabilityState.projectId === projectId ? projectAvailabilityState.status : 'available';

	// Side-effect-only hooks
	useIDEEffects({
		projectId,
		previewOrigin,
		handleSaveReference: editorState.handleSaveReference,
		cursorUpdateTimeoutReference: editorState.cursorUpdateTimeoutReference,
	});

	// Handle download
	const handleDownload = useCallback(async () => {
		try {
			const blob = await downloadProject(projectId);
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `${projectNameState.projectName ?? `project-${projectId.slice(0, 8)}`}.zip`;
			document.body.append(a);
			a.click();
			a.remove();
			URL.revokeObjectURL(url);
		} catch {
			toast.error('Could not download the project. Please check your connection and try again.');
		}
	}, [projectId, projectNameState.projectName]);

	// Handle deploy
	const handleDeploy = useCallback(() => {
		setDeployModalOpen(true);
	}, []);

	// Handle settings
	const handleSettings = useCallback(() => {
		setSettingsModalOpen(true);
	}, []);

	useEffect(() => {
		function handleProjectUnavailable(event: Event) {
			if (!(event instanceof CustomEvent)) {
				return;
			}

			const eventProjectId = Reflect.get(event.detail, 'projectId');
			const status = Reflect.get(event.detail, 'status');
			if (eventProjectId !== projectId) {
				return;
			}

			if (status === 'not-found' || status === 'forbidden') {
				setSettingsModalOpen(false);
				setProjectAvailabilityState({ projectId, status });
			}
		}

		globalThis.addEventListener('project-unavailable', handleProjectUnavailable);
		return () => globalThis.removeEventListener('project-unavailable', handleProjectUnavailable);
	}, [projectId]);

	if (projectAvailability === 'not-found') {
		return <ProjectNotFound />;
	}

	if (projectAvailability === 'forbidden') {
		return <ProjectAccessRestricted />;
	}

	return (
		<TooltipProvider>
			<AgentRuntimeProvider key={projectId} projectId={projectId}>
				<ProjectDeepLinkHandler projectId={projectId} deepLink={initialProjectDeepLink} onHandled={onInitialProjectDeepLinkHandled} />
				<title>{projectNameState.projectName ? `${projectNameState.projectName} | Codemaxxing` : 'Codemaxxing'}</title>
				<div className="flex h-full flex-col overflow-hidden bg-bg-primary">
					<IDEHeader
						projectNameState={projectNameState}
						isMobile={isMobile}
						agentPanelVisible={layouts.agentPanelVisible}
						toggleAgentPanel={toggleAgentPanel}
						isAgentProcessing={isAgentProcessing}
						mobileMenuOpen={mobileMenuOpen}
						setMobileMenuOpen={setMobileMenuOpen}
						onDownload={handleDownload}
						onDeploy={handleDeploy}
						onSettings={handleSettings}
					/>

					{isMobile ? (
						<MobileLayout
							projectId={projectId}
							resolvedTheme={resolvedTheme}
							editorState={editorState}
							fileTree={fileTree}
							logCounts={logCounts}
							previewIframeReference={previewIframeReference}
							previewUrl={previewUrl}
							previewOrigin={previewOrigin}
							isLoadingPreviewUrl={isLoadingPreviewUrl}
							refreshPreviewUrl={refreshPreviewUrl}
						/>
					) : (
						<DesktopLayout
							projectId={projectId}
							resolvedTheme={resolvedTheme}
							editorState={editorState}
							fileTree={fileTree}
							layouts={layouts}
							logCounts={logCounts}
							previewIframeReference={previewIframeReference}
							previewUrl={previewUrl}
							previewOrigin={previewOrigin}
							isLoadingPreviewUrl={isLoadingPreviewUrl}
							refreshPreviewUrl={refreshPreviewUrl}
						/>
					)}
					<DeployModal
						open={deployModalOpen}
						onOpenChange={setDeployModalOpen}
						projectId={projectId}
						projectName={projectNameState.projectName ?? `project-${projectId.slice(0, 8)}`}
					/>
					<ProjectSettingsModal open={settingsModalOpen} onOpenChange={setSettingsModalOpen} projectId={projectId} />
				</div>
			</AgentRuntimeProvider>
		</TooltipProvider>
	);
}
