import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
	const projectDeepLinkHandler = vi.fn();
	const toggleAgentPanel = vi.fn();

	const storeState = {
		toggleAgentPanel,
	};

	return {
		projectDeepLinkHandler,
		toggleAgentPanel,
		storeState,
	};
});

function useMockStore(selector?: (state: typeof mocks.storeState) => unknown) {
	if (!selector) {
		return mocks.storeState;
	}

	return selector(mocks.storeState);
}

vi.mock('@/components/ui/tooltip', () => ({
	TooltipProvider: ({ children }: { children: import('react').ReactNode }) => <>{children}</>,
}));

vi.mock('@/features/agent/index', () => ({
	AgentRuntimeProvider: ({ children }: { children: import('react').ReactNode; projectId: string }) => <>{children}</>,
}));

vi.mock('@/features/deploy/index', () => ({
	DeployModal: () => <div data-testid="deploy-modal" />,
}));

vi.mock('@/features/file-tree/index', () => ({
	useFileTree: () => ({
		files: [],
		selectedFile: undefined,
		expandedDirectories: new Set<string>(),
		selectFile: vi.fn(),
		toggleDirectory: vi.fn(),
		isLoading: false,
		createFile: vi.fn(),
		deleteFile: vi.fn(),
		renameFile: vi.fn(),
		createFolder: vi.fn(),
	}),
}));

vi.mock('@/features/project-settings/index', () => ({
	ProjectSettingsModal: () => <div data-testid="project-settings-modal" />,
}));

vi.mock('@/hooks/index', () => ({
	useIsMobile: () => false,
	useProjectSocket: vi.fn(),
	useResolvedTheme: () => 'dark',
}));

vi.mock('@/lib/api-client', () => ({
	downloadProject: vi.fn(async () => new Blob()),
}));

vi.mock('@/hooks/use-queued-save-flusher', () => ({
	useQueuedSaveFlusher: vi.fn(),
}));

vi.mock('@/lib/preview-origin', () => ({
	usePreviewUrl: () => ({
		previewUrl: 'https://example.com',
		previewOrigin: 'https://example.com',
		isLoading: false,
		refresh: vi.fn(async () => 'https://example.com'),
	}),
}));

vi.mock('@/lib/store', () => ({
	selectIsProcessing: () => false,
	useStore: useMockStore,
}));

vi.mock('./project-deep-link-handler', () => ({
	ProjectDeepLinkHandler: (properties: { projectId: string; deepLink?: unknown }) => {
		mocks.projectDeepLinkHandler(properties);
		return <div data-testid="project-deep-link-handler" />;
	},
}));

vi.mock('./desktop-layout', () => ({
	DesktopLayout: () => <div data-testid="desktop-layout" />,
}));

vi.mock('./ide-header', () => ({
	IDEHeader: () => <div data-testid="ide-header" />,
}));

vi.mock('./mobile-layout', () => ({
	MobileLayout: () => <div data-testid="mobile-layout" />,
}));

vi.mock('./use-project-state-persistence', () => ({
	useProjectStatePersistence: vi.fn(),
}));

vi.mock('./use-editor-session-persistence', () => ({
	useEditorSessionPersistence: vi.fn(),
}));

vi.mock('./use-editor-state', () => ({
	useEditorState: () => ({
		handleSaveReference: { current: vi.fn() },
		cursorUpdateTimeoutReference: { current: undefined },
	}),
}));

vi.mock('./use-ide-effects', () => ({
	useIDEEffects: vi.fn(),
}));

vi.mock('./use-log-counts', () => ({
	useLogCounts: () => ({ errors: 0, warnings: 0 }),
}));

vi.mock('./use-panel-layouts', () => ({
	usePanelLayouts: () => ({
		agentPanelVisible: false,
	}),
}));

vi.mock('./use-project-data-prefetch', () => ({
	useProjectDataPrefetch: vi.fn(),
}));

vi.mock('./use-project-name', () => ({
	useProjectName: () => ({ projectName: 'Project One' }),
}));

import { IDEShell } from './ide-shell';

describe('IDEShell deep links', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('passes the initial project deep link to the shared handler', () => {
		const deepLink = { kind: 'agent-session' as const, sessionId: 'session-2' };
		const onInitialProjectDeepLinkHandled = vi.fn();
		const view = render(
			<IDEShell
				projectId="project-1"
				initialProjectDeepLink={deepLink}
				onInitialProjectDeepLinkHandled={onInitialProjectDeepLinkHandled}
			/>,
		);

		expect(mocks.projectDeepLinkHandler).toHaveBeenCalledWith({
			projectId: 'project-1',
			deepLink,
			onHandled: onInitialProjectDeepLinkHandled,
		});

		const nextDeepLink = { kind: 'panel' as const, panel: 'preview' as const };
		view.rerender(
			<IDEShell
				projectId="project-1"
				initialProjectDeepLink={nextDeepLink}
				onInitialProjectDeepLinkHandled={onInitialProjectDeepLinkHandled}
			/>,
		);

		expect(mocks.projectDeepLinkHandler).toHaveBeenLastCalledWith({
			projectId: 'project-1',
			deepLink: nextDeepLink,
			onHandled: onInitialProjectDeepLinkHandled,
		});
	});
});
