import { AI_MODEL_IDS, DEFAULT_AI_MODEL } from '@shared/constants';
import { editorSessionSchema } from '@shared/validation';

import type { MobilePanel, SidebarView, UtilityTab } from '@/lib/store';
import type { AIModelId } from '@shared/constants';
import type { EditorSessionParsed } from '@shared/validation';

// ─── Default UI state ────────────────────────────────────────────────────────
// Panel/UI state is only persisted when it differs from these defaults.

const defaultMobilePanel: MobilePanel = 'preview';
const defaultSidebarView: SidebarView = 'explorer';
const defaultUtilityTab: UtilityTab = 'output';
const defaultSelectedModel: AIModelId = DEFAULT_AI_MODEL;

const DEFAULT_PROJECT_UI: ProjectUIState = {
	sidebarVisible: true,
	utilityPanelVisible: true,
	agentPanelVisible: false,
	devtoolsVisible: false,
	dependenciesPanelVisible: true,
	activeMobilePanel: defaultMobilePanel,
	activeSidebarView: defaultSidebarView,
	activeUtilityTab: defaultUtilityTab,
	expandedDirs: [],
	selectedModel: defaultSelectedModel,
};

export interface ProjectUIState {
	sidebarVisible: boolean;
	utilityPanelVisible: boolean;
	agentPanelVisible: boolean;
	devtoolsVisible: boolean;
	dependenciesPanelVisible: boolean;
	activeMobilePanel: MobilePanel;
	activeSidebarView: SidebarView;
	activeUtilityTab: UtilityTab;
	expandedDirs: string[];
	selectedModel: AIModelId;
}

// ─── Persisted project shape ─────────────────────────────────────────────────

export interface ProjectStorageData {
	editorSession?: EditorSessionParsed;
	ui?: Record<string, unknown>;
}

// ─── Key helpers ─────────────────────────────────────────────────────────────

function projectStorageKey(projectId: string): string {
	return `worker-ide-project:${projectId}`;
}

// ─── Read ────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== undefined && !Array.isArray(value) && value !== null;
}

function readRawProjectData(projectId: string): Record<string, unknown> | undefined {
	try {
		const raw = localStorage.getItem(projectStorageKey(projectId));
		if (!raw) return undefined;
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

function loadProjectStorage(projectId: string): ProjectStorageData {
	const raw = readRawProjectData(projectId);
	if (!raw) return {};

	const data: ProjectStorageData = {};

	// Editor session
	if (raw.editorSession) {
		const result = editorSessionSchema.safeParse(raw.editorSession);
		if (result.success) {
			data.editorSession = result.data;
		}
	}

	// UI overrides (partial — only non-default values are stored)
	if (isRecord(raw.ui)) {
		data.ui = raw.ui;
	}

	return data;
}

// ─── Write ───────────────────────────────────────────────────────────────────

function writeProjectStorage(projectId: string, data: ProjectStorageData): void {
	try {
		// Strip empty/default fields to keep the payload small
		const cleaned: Record<string, unknown> = {};
		if (data.editorSession) cleaned.editorSession = data.editorSession;
		if (data.ui && Object.keys(data.ui).length > 0) cleaned.ui = data.ui;

		if (Object.keys(cleaned).length === 0) {
			localStorage.removeItem(projectStorageKey(projectId));
			return;
		}

		localStorage.setItem(projectStorageKey(projectId), JSON.stringify(cleaned));
	} catch {
		// Storage full or unavailable — silently ignore
	}
}

// ─── Granular updaters ───────────────────────────────────────────────────────

/**
 * Merge a partial update into the stored project data.
 * Only reads + writes the single project key.
 */
function updateProjectStorage(projectId: string, updater: (current: ProjectStorageData) => ProjectStorageData): void {
	const current = loadProjectStorage(projectId);
	writeProjectStorage(projectId, updater(current));
}

// Editor session

export function loadEditorSession(projectId: string): EditorSessionParsed | undefined {
	return loadProjectStorage(projectId).editorSession;
}

export function saveEditorSession(projectId: string, session: EditorSessionParsed): void {
	updateProjectStorage(projectId, (current) => ({ ...current, editorSession: session }));
}

// Active AI session ID

export function getActiveSessionId(projectId: string): string | undefined {
	try {
		return sessionStorage.getItem(`think-session:${projectId}`) || undefined;
	} catch {
		return undefined;
	}
}

export function setActiveSessionId(projectId: string, sessionId: string | undefined): void {
	try {
		if (sessionId) sessionStorage.setItem(`think-session:${projectId}`, sessionId);
		else sessionStorage.removeItem(`think-session:${projectId}`);
	} catch {
		/* Storage may be unavailable. */
	}
}

export function loadAgentDraft(projectId: string): Record<string, unknown> | undefined {
	try {
		const raw = sessionStorage.getItem(`think-draft:${projectId}`);
		if (!raw) return;
		const value: unknown = JSON.parse(raw);
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

export function saveAgentDraft(projectId: string, draft: { segments: unknown[]; cursorPosition: number }): void {
	try {
		if (draft.segments.length === 0 && draft.cursorPosition === 0) sessionStorage.removeItem(`think-draft:${projectId}`);
		else sessionStorage.setItem(`think-draft:${projectId}`, JSON.stringify(draft));
	} catch {
		/* Storage may be unavailable. */
	}
}

export function clearAgentDraft(projectId: string): void {
	try {
		sessionStorage.removeItem(`think-draft:${projectId}`);
	} catch {
		/* Storage may be unavailable. */
	}
}

// UI state (only stores overrides that differ from defaults)

const MOBILE_PANELS = new Set<string>(['editor', 'preview', 'git', 'agent', 'tests']);
function isMobilePanel(value: unknown): value is MobilePanel {
	return typeof value === 'string' && MOBILE_PANELS.has(value);
}

const SIDEBAR_VIEWS = new Set<string>(['explorer', 'git', 'tests']);
function isSidebarView(value: unknown): value is SidebarView {
	return typeof value === 'string' && SIDEBAR_VIEWS.has(value);
}

const UTILITY_TABS = new Set<string>(['output']);
function isUtilityTab(value: unknown): value is UtilityTab {
	return typeof value === 'string' && UTILITY_TABS.has(value);
}

const AI_MODEL_ID_SET = new Set<string>(AI_MODEL_IDS);
function isAIModelId(value: unknown): value is AIModelId {
	return typeof value === 'string' && AI_MODEL_ID_SET.has(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function loadProjectUI(projectId: string): ProjectUIState {
	const overrides = loadProjectStorage(projectId).ui ?? {};
	return {
		sidebarVisible: typeof overrides.sidebarVisible === 'boolean' ? overrides.sidebarVisible : DEFAULT_PROJECT_UI.sidebarVisible,
		utilityPanelVisible:
			typeof overrides.utilityPanelVisible === 'boolean' ? overrides.utilityPanelVisible : DEFAULT_PROJECT_UI.utilityPanelVisible,
		agentPanelVisible:
			typeof overrides.agentPanelVisible === 'boolean' ? overrides.agentPanelVisible : DEFAULT_PROJECT_UI.agentPanelVisible,
		devtoolsVisible: typeof overrides.devtoolsVisible === 'boolean' ? overrides.devtoolsVisible : DEFAULT_PROJECT_UI.devtoolsVisible,
		dependenciesPanelVisible:
			typeof overrides.dependenciesPanelVisible === 'boolean'
				? overrides.dependenciesPanelVisible
				: DEFAULT_PROJECT_UI.dependenciesPanelVisible,
		activeMobilePanel: isMobilePanel(overrides.activeMobilePanel) ? overrides.activeMobilePanel : DEFAULT_PROJECT_UI.activeMobilePanel,
		activeSidebarView: isSidebarView(overrides.activeSidebarView) ? overrides.activeSidebarView : DEFAULT_PROJECT_UI.activeSidebarView,
		activeUtilityTab: isUtilityTab(overrides.activeUtilityTab) ? overrides.activeUtilityTab : DEFAULT_PROJECT_UI.activeUtilityTab,
		expandedDirs: isStringArray(overrides.expandedDirs) ? overrides.expandedDirs : DEFAULT_PROJECT_UI.expandedDirs,
		selectedModel: isAIModelId(overrides.selectedModel) ? overrides.selectedModel : DEFAULT_PROJECT_UI.selectedModel,
	};
}

function expandedDirectoriesChanged(current: string[], defaults: string[]): boolean {
	const defaultSet = new Set(defaults);
	return current.length !== defaultSet.size || !current.every((directory) => defaultSet.has(directory));
}

/**
 * Diff the given full UI state against defaults and persist only the deltas.
 */
export function saveProjectUI(projectId: string, state: ProjectUIState): void {
	const overrides: Record<string, unknown> = {};

	if (state.sidebarVisible !== DEFAULT_PROJECT_UI.sidebarVisible) overrides.sidebarVisible = state.sidebarVisible;
	if (state.utilityPanelVisible !== DEFAULT_PROJECT_UI.utilityPanelVisible) overrides.utilityPanelVisible = state.utilityPanelVisible;
	if (state.agentPanelVisible !== DEFAULT_PROJECT_UI.agentPanelVisible) overrides.agentPanelVisible = state.agentPanelVisible;
	if (state.devtoolsVisible !== DEFAULT_PROJECT_UI.devtoolsVisible) overrides.devtoolsVisible = state.devtoolsVisible;
	if (state.dependenciesPanelVisible !== DEFAULT_PROJECT_UI.dependenciesPanelVisible)
		overrides.dependenciesPanelVisible = state.dependenciesPanelVisible;
	if (state.activeMobilePanel !== DEFAULT_PROJECT_UI.activeMobilePanel) overrides.activeMobilePanel = state.activeMobilePanel;
	if (state.activeSidebarView !== DEFAULT_PROJECT_UI.activeSidebarView) overrides.activeSidebarView = state.activeSidebarView;
	if (state.activeUtilityTab !== DEFAULT_PROJECT_UI.activeUtilityTab) overrides.activeUtilityTab = state.activeUtilityTab;
	if (state.selectedModel !== DEFAULT_PROJECT_UI.selectedModel) overrides.selectedModel = state.selectedModel;
	if (expandedDirectoriesChanged(state.expandedDirs, [...DEFAULT_PROJECT_UI.expandedDirs])) overrides.expandedDirs = state.expandedDirs;

	updateProjectStorage(projectId, (current) => {
		const next = { ...current };
		if (Object.keys(overrides).length > 0) {
			next.ui = overrides;
		} else {
			delete next.ui;
		}
		return next;
	});
}
