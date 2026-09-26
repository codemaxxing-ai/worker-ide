import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useImperativeHandle, type ComponentProps, type ReactNode, type Ref } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_AI_MODEL } from '@shared/constants';

const mocks = vi.hoisted(() => {
	const submitMessage = vi.fn(async () => ({ sessionId: 'session-1', queued: true, started: false }));
	const abortRun = vi.fn(async () => {});
	const clearCurrentSession = vi.fn(async () => {});
	const speechStart = vi.fn(async () => {});
	const speechStop = vi.fn(() => '');
	const scrollToBottom = vi.fn();
	const resetScrollState = vi.fn();
	const setSegments = vi.fn();
	const setCursorPosition = vi.fn();
	const setImageAttachments = vi.fn();
	const setAgentMode = vi.fn();
	const setSelectedModel = vi.fn();
	const openFile = vi.fn();
	const clearPendingChangesByPaths = vi.fn();
	const shiftPendingPreviewElementReference = vi.fn();
	const setProcessing = vi.fn();
	const loadSession = vi.fn();
	const handleRenameSession = vi.fn(async () => true);
	const handleDeleteSession = vi.fn(async () => true);
	const revertCascadeAsync = vi.fn(async () => ({ reverted: [], failed: [], missingSnapshots: [] }));
	const handleApproveChange = vi.fn();
	const handleRejectChange = vi.fn();
	const handleApproveAll = vi.fn();
	const handleRejectAll = vi.fn();
	const toastError = vi.fn();
	const toastInfo = vi.fn();
	const setActiveSessionId = vi.fn();

	const storeState = {
		files: [],
		agentMode: 'code',
		selectedModel: '',
		openFile,
		setAgentMode,
		setSelectedModel,
		clearPendingChangesByPaths,
		pendingPreviewElementReferences: [],
		shiftPendingPreviewElementReference,
		pendingChanges: new Map(),
		setProcessing,
	};

	const agent = {
		state: {
			currentSession: {
				sessionId: 'session-1',
				status: 'running',
				statusText: undefined,
				contextTokensUsed: 1200,
				stopRequested: false,
				pendingQuestion: undefined,
				needsContinuation: false,
				doomLoopMessage: undefined,
				messages: [{ id: 'message-1', role: 'user', parts: [{ type: 'text', content: 'Hello' }], createdAt: 1 }],
			},
			sessions: [{ id: 'session-1', title: 'Current session', createdAt: 1, isRunning: true }],
			sessionParticipants: {},
		},
		identified: true,
		stub: {
			submitMessage,
			abortRun,
			clearCurrentSession,
		},
	};

	const agentRuntime = {
		agent,
		agentConnectionState: 'connected',
		isConnected: true,
		segments: [],
		setSegments,
		cursorPosition: 0,
		setCursorPosition,
		imageAttachments: [],
		setImageAttachments,
	};

	const speechToText = {
		microphonePermission: 'granted',
		needsPermissionApproval: false,
		isAwaitingPermission: false,
		isRecording: false,
		isMicrophoneReady: true,
		interimTranscript: '',
		finalTranscript: '',
		amplitudes: [0.2, 0.4],
		start: speechStart,
		stop: speechStop,
	};

	return {
		submitMessage,
		abortRun,
		clearCurrentSession,
		speechStart,
		speechStop,
		scrollToBottom,
		resetScrollState,
		setSegments,
		setCursorPosition,
		loadSession,
		handleRenameSession,
		handleDeleteSession,
		revertCascadeAsync,
		handleApproveChange,
		handleRejectChange,
		handleApproveAll,
		handleRejectAll,
		toastError,
		toastInfo,
		setActiveSessionId,
		storeState,
		agentRuntime,
		speechToText,
	};
});

mocks.storeState.selectedModel = DEFAULT_AI_MODEL;

function useMockStore(selector?: (state: typeof mocks.storeState) => unknown) {
	if (!selector) {
		return mocks.storeState;
	}

	return selector(mocks.storeState);
}

const noop = () => {};

Object.assign(useMockStore, {
	getState: () => mocks.storeState,
	subscribe: () => noop,
});

vi.mock('@base-ui/react/scroll-area', async () => {
	const Root = ({ children }: { children: ReactNode }) => <div>{children}</div>;
	function Viewport({ children, ref }: { children: ReactNode; ref?: Ref<HTMLDivElement> }) {
		return <div ref={ref}>{children}</div>;
	}
	const Scrollbar = ({ children }: { children: ReactNode }) => <div>{children}</div>;
	const Thumb = () => <div />;

	return { ScrollArea: { Root, Viewport, Scrollbar, Thumb } };
});

vi.mock('@/components/ui/button', () => ({
	Button: ({
		children,
		focusStyle: _focusStyle,
		isLoading: _isLoading,
		...properties
	}: ComponentProps<'button'> & { focusStyle?: string; isLoading?: boolean }) => <button {...properties}>{children}</button>,
}));

vi.mock('@/components/ui/collapsible', () => ({
	Collapsible: ({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) =>
		open ? <div className={className}>{children}</div> : undefined,
}));

vi.mock('@/components/ui/confirm-button', () => ({
	ConfirmButton: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/ui/dropdown-menu', () => ({
	DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	DropdownMenuItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/ui/inline-confirm-group', () => ({
	InlineConfirmGroup: ({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) => (
		<>
			<button type="button" onClick={onConfirm}>
				Confirm delete
			</button>
			<button type="button" onClick={onCancel}>
				Cancel delete
			</button>
		</>
	),
}));

vi.mock('@/components/ui/pending-approval-indicator', () => ({
	PendingApprovalIndicator: () => <div data-testid="pending-approval-indicator" />,
}));

vi.mock('@/components/ui/spinner', () => ({
	Spinner: () => <div data-testid="spinner" />,
}));

vi.mock('@/components/ui/toast-store', () => ({
	toast: {
		error: mocks.toastError,
		info: mocks.toastInfo,
	},
}));

vi.mock('@/components/ui/tooltip', () => ({
	Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('@/lib/project-storage', () => ({
	setActiveSessionId: mocks.setActiveSessionId,
}));

vi.mock('@/features/agent/hooks/use-agent-sessions', () => ({
	useAgentSessions: () => ({
		allSessions: [{ id: 'session-1', title: 'Current session', createdAt: 1, isRunning: true }],
		savedSessions: [{ id: 'session-1', title: 'Current session', createdAt: 1, isRunning: true }],
		handleLoadSession: mocks.loadSession,
		handleRenameSession: mocks.handleRenameSession,
		handleDeleteSession: mocks.handleDeleteSession,
		sessionSearchQuery: '',
		setSessionSearchQuery: vi.fn(),
		isRestoringSession: false,
	}),
}));

vi.mock('@/features/agent/lib/agent-state', () => ({
	isAgentState: (value: unknown) => value,
}));

vi.mock('@/features/snapshots', () => ({
	useSnapshots: () => ({ revertCascadeAsync: mocks.revertCascadeAsync, isReverting: false }),
}));

vi.mock('@/hooks/use-mobile-keyboard-height', () => ({
	useMobileKeyboardLayout: () => ({ style: undefined, ref: undefined }),
}));

vi.mock('@/lib/api-client', () => ({
	createApiClient: () => ({
		file: {
			$put: vi.fn(async () => {}),
			$delete: vi.fn(async () => {}),
		},
	}),
	downloadDebugLog: vi.fn(async () => {}),
}));

vi.mock('@/lib/auth-client', () => ({
	authClient: {
		useSession: () => ({ data: { user: { id: 'user-1' } } }),
	},
}));

vi.mock('@/lib/store', () => ({ useStore: useMockStore }));

vi.mock('./context-ring', () => ({
	ContextRing: () => <div data-testid="context-ring" />,
}));

vi.mock('./messages', () => ({
	AgentError: () => {},
	AssistantMessage: () => {},
	ContinuationPrompt: () => {},
	DoomLoopAlert: () => {},
	MessageBubble: () => {},
	QueuedSteeringStrip: () => {},
	UserQuestionPrompt: () => {},
	WelcomeScreen: () => {},
}));

vi.mock('./model-selector-dialog', () => ({
	ModelSelectorDropdown: () => <div data-testid="model-selector" />,
}));

vi.mock('../../hooks/use-auto-scroll', () => ({
	useAutoScroll: () => ({
		scrollReference: { current: undefined },
		anchorReference: { current: undefined },
		wrapperReference: { current: undefined },
		hasNewContent: false,
		scrollToBottom: mocks.scrollToBottom,
		resetScrollState: mocks.resetScrollState,
	}),
}));

vi.mock('../../hooks/use-change-review', () => ({
	useChangeReview: () => ({
		sessionPendingCount: () => 0,
		handleApproveChange: mocks.handleApproveChange,
		handleRejectChange: mocks.handleRejectChange,
		handleApproveAll: mocks.handleApproveAll,
		handleRejectAll: mocks.handleRejectAll,
		isReverting: false,
		canReject: true,
	}),
}));

vi.mock('../../hooks/use-file-mention', () => ({
	useFileMention: () => ({
		isOpen: false,
		results: [],
		selectedIndex: 0,
		handleKeyDown: () => false,
		selectFile: vi.fn(),
	}),
}));

vi.mock('../../hooks/use-speech-to-text', () => ({
	useSpeechToText: () => mocks.speechToText,
}));

vi.mock('../agent-mode-selector', () => ({
	AgentModeSelector: () => <div data-testid="agent-mode-selector" />,
}));

vi.mock('../agent-runtime-context', () => ({
	useAgentRuntime: () => mocks.agentRuntime,
}));

vi.mock('../audio-waveform', () => ({
	AudioWaveform: () => <div data-testid="audio-waveform" />,
}));

vi.mock('../changed-files-summary', () => ({
	ChangedFilesSummary: () => {},
}));

vi.mock('../file-mention-dropdown', () => ({
	FileMentionDropdown: () => {},
}));

vi.mock('../revert-confirm-dialog', () => ({
	RevertConfirmDialog: () => {},
}));

vi.mock('../rich-text-input', () => {
	function RichTextInput({
		inlineSuffix,
		ref,
	}: {
		inlineSuffix?: ReactNode;
		ref?: Ref<{
			clear: () => void;
			focus: () => void;
			moveCursorToEnd: () => void;
			setCursorPosition: () => void;
		}>;
	}) {
		useImperativeHandle(ref, () => ({
			clear: () => {},
			focus: () => {},
			moveCursorToEnd: () => {},
			setCursorPosition: () => {},
		}));

		return (
			<div>
				<div data-testid="rich-text-input" />
				{inlineSuffix}
			</div>
		);
	}

	return { RichTextInput };
});

import { AgentPanel } from './panel';

describe('AgentPanel footer controls', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.agentRuntime.segments = [];
		mocks.agentRuntime.agent.state.currentSession.status = 'running';
		mocks.agentRuntime.agent.state.currentSession.messages = [
			{ id: 'message-1', role: 'user', parts: [{ type: 'text', content: 'Hello' }], createdAt: 1 },
		];
		mocks.speechToText.microphonePermission = 'granted';
		mocks.speechToText.needsPermissionApproval = false;
		mocks.speechToText.isAwaitingPermission = false;
		mocks.speechToText.isRecording = false;
		mocks.speechToText.finalTranscript = '';
		mocks.speechToText.interimTranscript = '';
		mocks.speechToText.amplitudes = [0.2, 0.4];
		mocks.speechStop.mockReturnValue('');
	});

	it('keeps context, microphone, and send available during generation', () => {
		render(<AgentPanel projectId="project-1" className="h-full" />);

		expect(screen.getByTestId('context-ring')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Start voice input' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Queue message' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Stop generation' })).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
		expect(mocks.speechStart).toHaveBeenCalledTimes(1);
	});

	it('keeps the action cluster from collapsing underneath the selectors', () => {
		render(<AgentPanel projectId="project-1" className="h-full" />);

		expect(screen.getByTestId('agent-input-toolbar')).toHaveClass('@container', 'flex', 'flex-wrap-reverse');
		expect(screen.getByTestId('agent-input-toolbar-actions')).toHaveClass('ml-auto', 'shrink-0');
		expect(screen.getByTestId('agent-input-toolbar-actions')).not.toHaveClass('flex-1', 'min-w-0');
	});

	it('does not interrupt generation when starting or stopping STT', () => {
		const view = render(<AgentPanel projectId="project-1" className="h-full" />);

		fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));

		expect(mocks.speechStart).toHaveBeenCalledTimes(1);
		expect(mocks.abortRun).not.toHaveBeenCalled();
		expect(mocks.clearCurrentSession).not.toHaveBeenCalled();
		expect(screen.getByRole('button', { name: 'Stop generation' })).toBeInTheDocument();

		mocks.speechToText.isRecording = true;
		view.rerender(<AgentPanel projectId="project-1" className="h-full" />);

		expect(screen.getByRole('button', { name: 'Stop generation' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Stop recording' })).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }));

		expect(mocks.speechStop).toHaveBeenCalledTimes(1);
		expect(mocks.abortRun).not.toHaveBeenCalled();
		expect(mocks.clearCurrentSession).not.toHaveBeenCalled();
	});

	it('switches to the STT takeover while recording', () => {
		mocks.speechToText.isRecording = true;
		mocks.speechToText.finalTranscript = 'Need logs';
		mocks.speechToText.interimTranscript = 'now';
		mocks.speechStop.mockReturnValue('Need logs now');

		render(<AgentPanel projectId="project-1" className="h-full" />);

		expect(screen.getByRole('button', { name: 'Stop recording' })).toBeInTheDocument();
		expect(screen.getByTestId('audio-waveform')).toBeInTheDocument();
		expect(screen.queryByTestId('context-ring')).not.toBeInTheDocument();
		expect(screen.queryByTestId('agent-mode-selector')).not.toBeInTheDocument();
		expect(screen.queryByTestId('model-selector')).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Queue message' })).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }));
		expect(mocks.speechStop).toHaveBeenCalledTimes(1);
	});

	it('renames the current session through the header', async () => {
		render(<AgentPanel projectId="project-1" />);

		fireEvent.click(screen.getAllByRole('button', { name: 'Rename session' })[0]);
		const titleInput = screen.getByRole('textbox', { name: 'Rename session' });
		fireEvent.change(titleInput, { target: { value: 'Updated session' } });
		fireEvent.keyDown(titleInput, { key: 'Enter' });

		await waitFor(() => expect(mocks.handleRenameSession).toHaveBeenCalledWith('session-1', 'Updated session'));
	});

	it('requires confirmation before deleting a session', async () => {
		render(<AgentPanel projectId="project-1" />);

		fireEvent.click(screen.getByRole('button', { name: 'Delete Current session' }));
		expect(mocks.handleDeleteSession).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));

		await waitFor(() => expect(mocks.handleDeleteSession).toHaveBeenCalledWith('session-1'));
		expect(mocks.clearCurrentSession).toHaveBeenCalledWith('session-1');
	});
});
