import { ChevronUp, FolderOpen } from 'lucide-react';
import { lazy, Suspense, useCallback } from 'react';

import { ErrorBoundary } from '@/components/error-boundary';
import { Pill } from '@/components/ui/pill';
import {
	AgentPanelSkeleton,
	DevelopmentToolsPanelSkeleton,
	FileTreeSkeleton,
	OutputPanelSkeleton,
	PreviewPanelSkeleton,
} from '@/components/ui/skeleton';
import { DependencyPanel, FileTree, type useFileTree } from '@/features/file-tree/index';
import { GitPanel } from '@/features/git/index';
import { MobileFileDrawer } from '@/features/ide/mobile-file-drawer';
import { MobileTabBar } from '@/features/ide/mobile-tab-bar';
import { TestsPanel } from '@/features/tests/index';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';

import { EditorArea } from './editor-area';

import type { useEditorState } from './use-editor-state';
import type { LogCounts } from '@/features/output/index';

const AgentPanel = lazy(() => import('@/features/agent/index'));
const DevelopmentToolsPanel = lazy(() => import('@/features/devtools/index'));
const PreviewPanel = lazy(() => import('@/features/preview/index'));
const UtilityPanel = lazy(() => import('@/features/utility-panel/index'));

function PanelErrorFallback({ resetErrorBoundary }: { error: Error; resetErrorBoundary: () => void }) {
	return (
		<div
			className="
				flex h-full flex-col items-center justify-center gap-2 p-4 text-center
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

interface MobileLayoutProperties {
	projectId: string;
	resolvedTheme: 'light' | 'dark';
	editorState: ReturnType<typeof useEditorState>;
	fileTree: ReturnType<typeof useFileTree>;
	logCounts: LogCounts;
	previewIframeReference: React.RefObject<HTMLIFrameElement | null>;
	previewUrl: string | undefined;
	previewOrigin: string | undefined;
	isLoadingPreviewUrl: boolean;
	refreshPreviewUrl: () => Promise<string | undefined>;
}

export function MobileLayout({
	projectId,
	resolvedTheme,
	editorState,
	fileTree,
	logCounts,
	previewIframeReference,
	previewUrl,
	previewOrigin,
	isLoadingPreviewUrl,
	refreshPreviewUrl,
}: MobileLayoutProperties) {
	const activeMobilePanel = useStore((state) => state.activeMobilePanel);
	const mobileFileTreeOpen = useStore((state) => state.mobileFileTreeOpen);
	const toggleMobileFileTree = useStore((state) => state.toggleMobileFileTree);
	const utilityPanelVisible = useStore((state) => state.utilityPanelVisible);
	const toggleUtilityPanel = useStore((state) => state.toggleUtilityPanel);
	const devtoolsVisible = useStore((state) => state.devtoolsVisible);

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

	const { gitStatusMap, participants } = editorState;

	// Mobile: select file and close the drawer
	const handleMobileSelectFile = useCallback(
		(path: string) => {
			editorState.selectFileFromTree(path);
			selectFile(path);
			if (mobileFileTreeOpen) {
				toggleMobileFileTree();
			}
		},
		[editorState, selectFile, mobileFileTreeOpen, toggleMobileFileTree],
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
			<div className="min-h-0 flex-1 overflow-hidden">
				{activeMobilePanel === 'editor' && (
					<div className="flex h-full flex-col overflow-hidden">
						<EditorArea
							projectId={projectId}
							resolvedTheme={resolvedTheme}
							editorState={editorState}
							onSelectFile={handleMobileSelectFile}
							tabsPrefix={
								<button
									type="button"
									onClick={toggleMobileFileTree}
									className={cn(
										'flex w-9 shrink-0 cursor-pointer items-center justify-center',
										`
											border-r border-b border-border bg-bg-secondary text-text-secondary
											transition-colors
										`,
										'hover:bg-bg-tertiary hover:text-text-primary',
									)}
									aria-label="Open file tree"
								>
									<FolderOpen className="size-4" />
								</button>
							}
						/>
						{utilityPanelVisible ? (
							<div className="flex h-48 shrink-0 flex-col border-t border-border">
								<Suspense fallback={<OutputPanelSkeleton showUtilityHeader />}>
									<UtilityPanel projectId={projectId} onToggle={toggleUtilityPanel} logCounts={logCounts} className="h-full" />
								</Suspense>
							</div>
						) : (
							<button
								type="button"
								onClick={toggleUtilityPanel}
								className={cn(
									'flex h-7 w-full shrink-0 cursor-pointer items-center',
									'border-t border-border bg-bg-secondary px-2 transition-colors',
									'hover:bg-bg-tertiary',
								)}
								aria-label="Show output"
							>
								<div className="flex items-center gap-2">
									<ChevronUp className="size-3 text-text-secondary" />
									<span className="text-xs font-medium text-text-secondary">Output</span>
									{logCounts.errors > 0 && <Pill color="red">{logCounts.errors}</Pill>}
									{logCounts.warnings > 0 && <Pill color="yellow">{logCounts.warnings}</Pill>}
								</div>
							</button>
						)}
					</div>
				)}

				{/* Keep the preview mounted so the in-page devtools bridge survives tab switches. */}
				<div className={cn('flex h-full flex-col overflow-hidden', activeMobilePanel !== 'preview' && 'hidden')}>
					<div className={cn('overflow-hidden', devtoolsVisible ? 'h-1/2' : 'flex-1')}>
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
					</div>
					{devtoolsVisible && (
						<div className="h-1/2 border-t border-border">
							<Suspense fallback={<DevelopmentToolsPanelSkeleton />}>
								<DevelopmentToolsPanel previewIframeReference={previewIframeReference} previewOrigin={previewOrigin} className="h-full" />
							</Suspense>
						</div>
					)}
				</div>

				{activeMobilePanel === 'git' && (
					<ErrorBoundary fallback={PanelErrorFallback}>
						<GitPanel projectId={projectId} className="h-full" />
					</ErrorBoundary>
				)}

				{activeMobilePanel === 'tests' && <TestsPanel projectId={projectId} className="h-full" />}

				{activeMobilePanel === 'agent' && (
					<Suspense fallback={<AgentPanelSkeleton />}>
						<AgentPanel projectId={projectId} className="h-full" />
					</Suspense>
				)}
			</div>

			<MobileTabBar />

			<MobileFileDrawer>
				{isLoadingFiles ? (
					<FileTreeSkeleton />
				) : (
					<FileTree
						participants={participants}
						files={files}
						selectedFile={selectedFile}
						expandedDirectories={expandedDirectories}
						onFileSelect={handleMobileSelectFile}
						onDirectoryToggle={toggleDirectory}
						onCreateFile={handleCreateFile}
						onDeleteFile={deleteFile}
						onRenameFile={handleRenameFile}
						onCreateFolder={handleCreateFolder}
						onMoveFile={handleMoveFile}
						gitStatusMap={gitStatusMap}
						className="flex-1"
					/>
				)}
				<div className="max-h-[40%] shrink-0 overflow-auto border-t border-border">
					<DependencyPanel projectId={projectId} />
				</div>
			</MobileFileDrawer>
		</>
	);
}
