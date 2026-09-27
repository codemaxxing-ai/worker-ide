import { expect, fn, within } from 'storybook/test';

import { AgentRuntimeContext } from '@/features/agent/components/agent-runtime-context';
import { createUnavailableAgentRunnerStub } from '@/features/agent/lib/agent-stub';

import { EditorArea } from './editor-area';

import type { useEditorState } from './use-editor-state';
import type { AgentRuntimeValue } from '@/features/agent/components/agent-runtime-context';
import type { Meta, StoryObj } from '@storybook/react-vite';

// Since useChangeReview isn't easily imported as a type for mocking, we just cast the mock
const mockChangeReview = {
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
	openFiles: ['src/main.ts', 'src/utils.ts'],
	unsavedChanges: new Map(),
	participants: [],
	cursorPosition: { line: 10, column: 5 },
	isLoadingContent: false,
	isSaving: false,
	editorContent: 'console.log("Hello, Worker IDE!");\n\nexport function main() {\n  return true;\n}\n',
	tabs: [
		{ path: 'src/main.ts', hasUnsavedChanges: false, isSaving: false, label: 'main.ts' },
		{ path: 'src/utils.ts', hasUnsavedChanges: true, isSaving: false, label: 'utils.ts' },
	],
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

const meta = {
	title: 'IDE/EditorArea',
	component: EditorArea,
	parameters: {
		layout: 'fullscreen',
	},
	tags: ['autodocs'],
	args: {
		projectId: 'test-project',
		resolvedTheme: 'dark',
		editorState: defaultMockEditorState,
		onSelectFile: fn(),
	},
	decorators: [
		(Story) => (
			<AgentRuntimeContext.Provider value={mockAgentRuntimeValue}>
				<div className="flex h-[400px] flex-col border border-border bg-bg-primary">
					<Story />
				</div>
			</AgentRuntimeContext.Provider>
		),
	],
} satisfies Meta<typeof EditorArea>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DefaultView: Story = {
	play: async ({ canvasElement, step }) => {
		const canvas = within(canvasElement);

		await step('Verify tabs and empty code editor exist', async () => {
			// Tab should exist
			await expect(await canvas.findByText('main.ts')).toBeInTheDocument();
			await expect(await canvas.findByText('utils.ts')).toBeInTheDocument();
		});
	},
};

export const LoadingContent: Story = {
	args: {
		projectId: 'test-project',
		editorState: {
			...defaultMockEditorState,
			isLoadingContent: true,
		},
	},
	play: async ({ canvasElement, step }) => {
		const canvas = within(canvasElement);
		await step('Verify empty file or spinner', async () => {
			// CodeEditor isn't rendered, a spinner is
			await expect(canvas.queryByRole('textbox')).not.toBeInTheDocument(); // CodeMirror usually has deep roles, but checking lack of it
		});
	},
};

export const NoFileSelected: Story = {
	args: {
		projectId: 'test-project',
		editorState: {
			...defaultMockEditorState,
			activeFile: undefined,
			tabs: [],
		},
	},
	play: async ({ canvasElement, step }) => {
		const canvas = within(canvasElement);
		await step('Verify empty state message', async () => {
			await expect(await canvas.findByText('Select a file to edit')).toBeInTheDocument();
		});
	},
};
