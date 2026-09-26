import { lazy, Suspense, useCallback, useMemo } from 'react';
import { Group as PanelGroup, Panel } from 'react-resizable-panels';

import { ErrorBoundary } from '@/components/error-boundary';
import {
	AgentPanelSkeleton,
	DevelopmentToolsPanelSkeleton,
	FileTreeSkeleton,
	OutputPanelSkeleton,
	PreviewPanelSkeleton,
} from '@/components/ui/skeleton';
import { DependencyPanel, FileTree, type useFileTree } from '@/features/file-tree/index';
import { GitPanel } from '@/features/git/index';
import { ActivityBar } from '@/features/ide/activity-bar';
import { TestsPanel } from '@/features/tests/index';
import { useStore } from '@/lib/store';

import { EditorArea } from './editor-area';
import { IDEStatusBar } from './ide-status-bar';
import { PanelDivider } from './panel-divider';

import type { useEditorState } from './use-editor-state';
import type { usePanelLayouts } from './use-panel-layouts';
import type { LogCounts } from '@/features/output/index';
const BOTTOM_PANEL_DEFAULT_SIZE = '30%';
const TOP_PANEL_DEFAULT_SIZE = '70%';

const AgentPanel = lazy(() => import('@/features/agent/index'));
const DevelopmentToolsPanel = lazy(() => import('@/features/devtools/index'));
const PreviewPanel = lazy(() => import('@/features/preview/index'));
const UtilityPanel = lazy(() => import('@/features/utility-panel/index'));

function PanelErrorFallback({ resetErrorBoundary }: { error: Error; resetErrorBoundary: () => void }) {
	return (
		<div
			className="
				flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center
			"
		>
			<p className="text-sm text-text-secondary">Something went wrong loading this panel.</p>
			<button
				onClick={resetErrorBoundary}
				className="
					cursor-pointer text-xs text-accent underline
					hover:text-accent-hover
				"
			>
				Retry
			</button>
		</div>
	);
}

interface DesktopLayoutProperties {
	projectId: string;
	resolvedTheme: 'light' | 'dark';
	editorState: ReturnType<typeof useEditorState>;
	fileTree: ReturnType<typeof useFileTree>;
	layouts: ReturnType<typeof usePanelLayouts>;
	logCounts: LogCounts;
	previewIframeReference: React.RefObject<HTMLIFrameElement | null>;
	previewUrl: string | undefined;
	previewOrigin: string | undefined;
	isLoadingPreviewUrl: boolean;
	refreshPreviewUrl: () => Promise<string | undefined>;
}

export function DesktopLayout({
	projectId,
	resolvedTheme,
	editorState,
	fileTree,
	layouts,
	logCounts,
	previewIframeReference,
	previewUrl,
	previewOrigin,
	isLoadingPreviewUrl,
	refreshPreviewUrl,
}: DesktopLayoutProperties) {
	const activeSidebarView = useStore((state) => state.activeSidebarView);
	const toggleUtilityPanel = useStore((state) => state.toggleUtilityPanel);
	const toggleDependenciesPanel = useStore((state) => state.toggleDependenciesPanel);
	const isConnected = useStore((state) => state.isConnected);
	const localParticipantColor = useStore((state) => state.localParticipantColor);

	const {
		files,
		selectedFile,
		expandedDirectories,
		selectFile,
		toggleDirectory,
		isLoading: isLoadingFiles,
		createFile,
		deleteFile,
		renameFile,
		createFolder,
	} = fileTree;

	const { participants, cursorPosition, isSaving, gitStatusMap } = editorState;

	const {
		agentPanelVisible,
		utilityPanelVisible,
		devtoolsVisible,
		dependenciesPanelVisible,
		mainLayout,
		sidebarLayout,
		editorTerminalLayout,
		previewDevtoolsLayout,
	} = layouts;

	const handleSelectFile = useCallback(
		(path: string) => {
			editorState.selectFileFromTree(path);
			selectFile(path);
		},
		[editorState, selectFile],
	);

	const handleCreateFile = useCallback(
		(path: string) => {
			createFile({ path, content: '' });
		},
		[createFile],
	);

	const handleRenameFile = useCallback(
		(fromPath: string, toPath: string) => {
			renameFile({ fromPath, toPath });
		},
		[renameFile],
	);

	const utilityHeaderRight = useMemo(
		() =>
			cursorPosition ? (
				<span className="shrink-0 text-xs text-text-secondary">
					Ln {cursorPosition.line}, Col {cursorPosition.column}
				</span>
			) : undefined,
		[cursorPosition],
	);

	const handleCreateFolder = useCallback(
		(path: string) => {
			createFolder(path);
		},
		[createFolder],
	);

	const handleMoveFile = useCallback(
		(fromPath: string, toPath: string) => {
			renameFile({ fromPath, toPath });
		},
		[renameFile],
	);

	return (
		<>
			<PanelGroup
				orientation="horizontal"
				id="ide-main"
				className="min-h-0 flex-1"
				defaultLayout={mainLayout.defaultLayout}
				onLayoutChanged={mainLayout.onLayoutChanged}
			>
				<Panel id="sidebar" defaultSize="15%" minSize="180px" maxSize="25%">
					<div className="flex h-full">
						<ActivityBar />
						<aside
							className="
								flex min-w-0 flex-1 flex-col border-r border-border bg-bg-secondary
							"
						>
							{activeSidebarView === 'explorer' ? (
								<>
									<PanelGroup
										orientation="vertical"
										id="sidebar-panels"
										className="flex-1"
										defaultLayout={sidebarLayout.defaultLayout}
										onLayoutChanged={sidebarLayout.onLayoutChanged}
									>
										<Panel id="file-tree" defaultSize={dependenciesPanelVisible ? TOP_PANEL_DEFAULT_SIZE : '100%'} minSize="20%">
											<div className="flex h-full flex-col overflow-hidden">
												{isLoadingFiles ? (
													<FileTreeSkeleton />
												) : (
													<FileTree
														participants={participants}
														files={files}
														selectedFile={selectedFile}
														expandedDirectories={expandedDirectories}
														onFileSelect={handleSelectFile}
														onDirectoryToggle={toggleDirectory}
														onCreateFile={handleCreateFile}
														onDeleteFile={deleteFile}
														onRenameFile={handleRenameFile}
														onCreateFolder={handleCreateFolder}
														onMoveFile={handleMoveFile}
														gitStatusMap={gitStatusMap}
													/>
												)}
											</div>
										</Panel>
										{dependenciesPanelVisible && (
											<>
												<PanelDivider orientation="vertical" />
												<Panel id="dependencies" defaultSize={BOTTOM_PANEL_DEFAULT_SIZE} minSize="10%" maxSize="60%">
													<div className="h-full overflow-auto">
														<DependencyPanel projectId={projectId} onToggle={toggleDependenciesPanel} />
													</div>
												</Panel>
											</>
										)}
									</PanelGroup>
									{!dependenciesPanelVisible && <DependencyPanel projectId={projectId} collapsed onToggle={toggleDependenciesPanel} />}
								</>
							) : activeSidebarView === 'tests' ? (
								<TestsPanel projectId={projectId} className="flex-1" />
							) : (
								<ErrorBoundary fallback={PanelErrorFallback}>
									<GitPanel projectId={projectId} className="flex-1" />
								</ErrorBoundary>
							)}
						</aside>
					</div>
				</Panel>

				<PanelDivider orientation="horizontal" />

				<Panel id="editor-col" defaultSize="45%" minSize="20%">
					<div className="flex h-full flex-col overflow-hidden">
						<PanelGroup
							orientation="vertical"
							id="ide-editor-terminal"
							className="flex-1"
							defaultLayout={editorTerminalLayout.defaultLayout}
							onLayoutChanged={editorTerminalLayout.onLayoutChanged}
						>
							<Panel id="editor" defaultSize={utilityPanelVisible ? TOP_PANEL_DEFAULT_SIZE : '100%'} minSize="30%">
								<div className="flex h-full flex-col overflow-hidden">
									<EditorArea
										projectId={projectId}
										resolvedTheme={resolvedTheme}
										editorState={editorState}
										onSelectFile={handleSelectFile}
									/>
								</div>
							</Panel>

							{utilityPanelVisible && (
								<>
									<PanelDivider orientation="vertical" />
									<Panel id="utility-panel" defaultSize={BOTTOM_PANEL_DEFAULT_SIZE} minSize="10%" maxSize="60%">
										<Suspense fallback={<OutputPanelSkeleton showUtilityHeader />}>
											<UtilityPanel
												projectId={projectId}
												onToggle={toggleUtilityPanel}
												logCounts={logCounts}
												headerRight={utilityHeaderRight}
												className="h-full"
											/>
										</Suspense>
									</Panel>
								</>
							)}
						</PanelGroup>

						{!utilityPanelVisible && (
							<Suspense fallback={undefined}>
								<UtilityPanel
									projectId={projectId}
									onToggle={toggleUtilityPanel}
									collapsed
									logCounts={logCounts}
									headerRight={utilityHeaderRight}
									className="shrink-0 border-t border-border"
								/>
							</Suspense>
						)}
					</div>
				</Panel>

				<PanelDivider orientation="horizontal" />

				<Panel id="preview-col" defaultSize={agentPanelVisible ? '20%' : '40%'} minSize="15%">
					<PanelGroup
						orientation="vertical"
						id="ide-preview-devtools"
						defaultLayout={previewDevtoolsLayout.defaultLayout}
						onLayoutChanged={previewDevtoolsLayout.onLayoutChanged}
					>
						<Panel id="preview" defaultSize={devtoolsVisible ? '70%' : '100%'} minSize="20%">
							<Suspense fallback={<PreviewPanelSkeleton />}>
								<PreviewPanel
									previewUrl={previewUrl}
									previewOrigin={previewOrigin}
									isLoadingUrl={isLoadingPreviewUrl}
									refreshPreviewUrl={refreshPreviewUrl}
									iframeReference={previewIframeReference}
									className="h-full"
								/>
							</Suspense>
						</Panel>

						{devtoolsVisible && (
							<>
								<PanelDivider orientation="vertical" />
								<Panel id="devtools" defaultSize="30%" minSize="15%" maxSize="80%">
									<Suspense fallback={<DevelopmentToolsPanelSkeleton />}>
										<DevelopmentToolsPanel
											previewIframeReference={previewIframeReference}
											previewOrigin={previewOrigin}
											className="h-full"
										/>
									</Suspense>
								</Panel>
							</>
						)}
					</PanelGroup>
				</Panel>

				{agentPanelVisible && (
					<>
						<PanelDivider orientation="horizontal" />
						<Panel id="agent-panel" defaultSize="20%" minSize="15%" maxSize="35%">
							<aside className="flex h-full flex-col border-l border-border">
								<Suspense fallback={<AgentPanelSkeleton />}>
									<AgentPanel projectId={projectId} className="h-full" />
								</Suspense>
							</aside>
						</Panel>
					</>
				)}
			</PanelGroup>

			<IDEStatusBar
				isConnected={isConnected}
				localParticipantColor={localParticipantColor}
				participants={participants}
				isSaving={isSaving}
			/>
		</>
	);
}
