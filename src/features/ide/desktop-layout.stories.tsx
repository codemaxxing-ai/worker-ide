import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Suspense } from 'react';
import { expect, fn, within } from 'storybook/test';

import { AgentRuntimeContext } from '@/features/agent/components/agent-runtime-context';
import { createUnavailableAgentRunnerStub } from '@/features/agent/lib/agent-stub';

import { DesktopLayout } from './desktop-layout';

import type { useEditorState } from './use-editor-state';
import type { usePanelLayouts } from './use-panel-layouts';
import type { AgentRuntimeValue } from '@/features/agent/components/agent-runtime-context';
import type { useFileTree } from '@/features/file-tree/index';
import type { LogCounts } from '@/features/output/index';
import type { Meta, StoryObj } from '@storybook/react-vite';

const mockChangeReview: ReturnType<typeof useEditorState>['changeReview'] = {
	handleApproveChange: fn(),
	handleRejectChange: fn(),
	isReverting: false,
	canReject: true,
	handleApproveHunk: fn(),
	handleRejectHunk: fn(),
	pendingChanges: new Map(),
	unresolvedChanges: [],
	pendingCount: 0,
	sessionPendingCount: () => 0,
	persistPendingChanges: fn(() => Promise.resolve()),
	handleRejectAll: fn(() => Promise.resolve()),
	handleApproveAll: fn(() => Promise.resolve()),
};

const defaultMockEditorState: ReturnType<typeof useEditorState> = {
	activeFile: 'src/main.ts',
	openFiles: ['src/main.ts'],
	unsavedChanges: new Map(),
	participants: [],
	cursorPosition: { line: 1, column: 1 },
	isLoadingContent: false,
	isSaving: false,
	editorContent: 'console.log("Desktop!");',
	tabs: [{ path: 'src/main.ts', hasUnsavedChanges: false, isSaving: false, label: 'main.ts' }],
	gitDiffView: undefined,
	clearGitDiff: fn(),
	isGitDiffActive: false,
	hasActiveDiff: false,
	activePendingChange: undefined,
	effectiveDiffData: undefined,
	changeReview: mockChangeReview,
	gitStatusMap: new Map(),
	handleEditorChange: fn(),
	handleSave: fn(() => Promise.resolve()),
	handleSaveReference: { current: fn(() => Promise.resolve()) },
	handleEditorBlur: fn(),
	handleViewReady: fn(),
	handlePrettify: fn(() => Promise.resolve()),
	isPrettifying: false,
	handleCloseFile: fn(),
	handleCursorChange: fn(),
	selectFileFromTree: fn(),
	cursorUpdateTimeoutReference: { current: undefined },
	pendingGoTo: undefined,
	clearPendingGoTo: fn(),
	goToFilePosition: fn(),
	pendingChanges: new Map(),
	markFileChanged: fn(),
	isLintableFile: () => true,
};

const mockAgentRuntimeValue = {
	agent: {
		identified: true,
		state: {
			currentSession: undefined,
			sessions: [],
			sessionParticipants: {},
			reviewEntries: {},
			reviewSummary: { unresolvedCount: 0, reviewVersion: 0, sessionCounts: {} },
		},
		addEventListener: fn(),
		removeEventListener: fn(),
		stub: createUnavailableAgentRunnerStub(),
	},
	agentConnectionState: 'connected',
	isConnected: true,
	segments: [],
	setSegments: fn(),
	cursorPosition: 0,
	setCursorPosition: fn(),
	imageAttachments: [],
	setImageAttachments: fn(),
} satisfies AgentRuntimeValue;

const defaultMockFileTree: ReturnType<typeof useFileTree> = {
	files: [
		{ name: 'src', path: 'src', isDirectory: true },
		{ name: 'main.ts', path: 'src/main.ts', isDirectory: false },
	],
	selectedFile: 'src/main.ts',
	expandedDirectories: new Set(['src']),
	isLoading: false,
	isError: false,
	error: undefined,
	refetch: fn(() => Promise.resolve()),
	isCreating: false,
	isDeleting: false,
	isRenaming: false,
	isCreatingFolder: false,
	selectFile: fn(),
	toggleDirectory: fn(),
	createFile: fn(),
	deleteFile: fn(),
	renameFile: fn(),
	createFolder: fn(),
};

const mockLayouts: ReturnType<typeof usePanelLayouts> = {
	agentPanelVisible: false,
	utilityPanelVisible: true,
	devtoolsVisible: false,
	dependenciesPanelVisible: true,
	mainLayout: { defaultLayout: undefined, onLayoutChanged: fn(), onLayoutChange: fn() },
	sidebarLayout: { defaultLayout: undefined, onLayoutChanged: fn(), onLayoutChange: fn() },
	editorTerminalLayout: { defaultLayout: undefined, onLayoutChanged: fn(), onLayoutChange: fn() },
	previewDevtoolsLayout: { defaultLayout: undefined, onLayoutChanged: fn(), onLayoutChange: fn() },
};

const defaultMockLogCounts: LogCounts = { errors: 0, warnings: 0, logs: 0 };

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const meta = {
	title: 'IDE/DesktopLayout',
	component: DesktopLayout,
	parameters: {
		layout: 'fullscreen',
	},
	tags: ['autodocs'],
	args: {
		projectId: '494rtk7ddoepe5ru2lx4oc855i6lc23p3apolh04feq8q517sa',
		resolvedTheme: 'dark',
		editorState: defaultMockEditorState,
		fileTree: defaultMockFileTree,
		layouts: mockLayouts,
		logCounts: defaultMockLogCounts,
		previewIframeReference: { current: document.createElement('iframe') },
		previewUrl: 'http://494rtk7ddoepe5ru2lx4oc855i6lc23p3apolh04feq8q517sa-a1b2c3d4e5f6.preview.localhost:3000/',
		previewOrigin: 'http://494rtk7ddoepe5ru2lx4oc855i6lc23p3apolh04feq8q517sa-a1b2c3d4e5f6.preview.localhost:3000',
		isLoadingPreviewUrl: false,
		refreshPreviewUrl: fn(async (): Promise<string | undefined> => undefined),
	},
	decorators: [
		(Story) => (
			<QueryClientProvider client={queryClient}>
				<AgentRuntimeContext.Provider value={mockAgentRuntimeValue}>
					<Suspense fallback={<div>Loading...</div>}>
						<div className="flex h-full flex-col overflow-hidden bg-bg-primary">
							<Story />
						</div>
					</Suspense>
				</AgentRuntimeContext.Provider>
			</QueryClientProvider>
		),
	],
} satisfies Meta<typeof DesktopLayout>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DefaultView: Story = {
	play: async ({ canvasElement, step }) => {
		const canvas = within(canvasElement);
		await step('Verify editor tabs are visible', async () => {
			await expect(await canvas.findByText('main.ts')).toBeInTheDocument();
		});
		await step('Verify status bar is visible', async () => {
			await expect(await canvas.findByText('Disconnected')).toBeInTheDocument();
		});
	},
};
