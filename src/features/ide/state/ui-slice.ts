import { DEFAULT_EDITOR_FONT, EDITOR_FONT_SLUGS } from '@shared/constants';

import type { StoreState } from '@/lib/store';
import type { EditorFont } from '@shared/constants';
import type { StateCreator } from 'zustand';

type ColorScheme = 'light' | 'dark' | 'system';

export type MobilePanel = 'editor' | 'preview' | 'git' | 'agent' | 'tests';

export type SidebarView = 'explorer' | 'git' | 'tests';

export type UtilityTab = 'output';

export interface UIState {
	sidebarVisible: boolean;
	utilityPanelVisible: boolean;
	agentPanelVisible: boolean;
	requestedAgentSessionId: string | undefined;
	devtoolsVisible: boolean;
	dependenciesPanelVisible: boolean;
	colorScheme: ColorScheme;
	editorFont: EditorFont;
	isAppearanceModalOpen: boolean;
	activeMobilePanel: MobilePanel;
	mobileFileTreeOpen: boolean;
	activeSidebarView: SidebarView;
	activeUtilityTab: UtilityTab;
}

export interface UIActions {
	toggleSidebar: () => void;
	toggleUtilityPanel: () => void;
	toggleAgentPanel: () => void;
	showAgentPanel: () => void;
	requestAgentSession: (sessionId: string) => void;
	clearRequestedAgentSession: () => void;
	toggleDevtools: () => void;
	toggleDependenciesPanel: () => void;
	setColorScheme: (scheme: ColorScheme) => void;
	setEditorFont: (font: EditorFont) => void;
	setAppearanceModalOpen: (open: boolean) => void;
	setActiveMobilePanel: (panel: MobilePanel) => void;
	toggleMobileFileTree: () => void;
	setActiveSidebarView: (view: SidebarView) => void;
	showDependenciesPanel: () => void;
	showUtilityPanel: (tab: UtilityTab) => void;
}

const PREFERENCES_CACHE_KEY = 'worker-ide-preferences';
const COLOR_SCHEME_VALUES: Set<string> = new Set(['light', 'dark', 'system']);
const EDITOR_FONT_VALUES = new Set<string>(EDITOR_FONT_SLUGS);

function isColorScheme(value: unknown): value is ColorScheme {
	return typeof value === 'string' && COLOR_SCHEME_VALUES.has(value);
}

function isEditorFont(value: unknown): value is EditorFont {
	return typeof value === 'string' && EDITOR_FONT_VALUES.has(value);
}

/**
 * Read cached preferences from localStorage to seed store defaults.
 * This avoids a flash of wrong theme/font before the server fetch completes.
 */
function readCachedPreferences(): { colorScheme: ColorScheme; editorFont: EditorFont } {
	const defaultColorScheme: ColorScheme = 'dark';
	const defaults = { colorScheme: defaultColorScheme, editorFont: DEFAULT_EDITOR_FONT };
	try {
		const raw = localStorage.getItem(PREFERENCES_CACHE_KEY);
		if (!raw) return defaults;
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || !parsed) return defaults;
		return {
			colorScheme: 'colorScheme' in parsed && isColorScheme(parsed.colorScheme) ? parsed.colorScheme : defaults.colorScheme,
			editorFont: 'editorFont' in parsed && isEditorFont(parsed.editorFont) ? parsed.editorFont : defaults.editorFont,
		};
	} catch {
		return defaults;
	}
}

const cachedPreferences = readCachedPreferences();

export const createUISlice: StateCreator<StoreState, [['zustand/devtools', never]], [], UIState & UIActions> = (set) => ({
	sidebarVisible: true,
	utilityPanelVisible: true,
	agentPanelVisible: false,
	requestedAgentSessionId: undefined,
	devtoolsVisible: false,
	dependenciesPanelVisible: true,
	colorScheme: cachedPreferences.colorScheme,
	editorFont: cachedPreferences.editorFont,
	isAppearanceModalOpen: false,
	activeMobilePanel: 'preview',
	mobileFileTreeOpen: false,
	activeSidebarView: 'explorer',
	activeUtilityTab: 'output',
	toggleSidebar: () => set((state) => ({ sidebarVisible: !state.sidebarVisible })),

	toggleUtilityPanel: () => set((state) => ({ utilityPanelVisible: !state.utilityPanelVisible })),

	toggleAgentPanel: () => set((state) => ({ agentPanelVisible: !state.agentPanelVisible })),

	showAgentPanel: () => set({ agentPanelVisible: true, activeMobilePanel: 'agent' }),

	requestAgentSession: (sessionId) =>
		set({
			agentPanelVisible: true,
			activeMobilePanel: 'agent',
			requestedAgentSessionId: sessionId,
		}),

	clearRequestedAgentSession: () => set({ requestedAgentSessionId: undefined }),

	toggleDevtools: () => set((state) => ({ devtoolsVisible: !state.devtoolsVisible })),

	toggleDependenciesPanel: () => set((state) => ({ dependenciesPanelVisible: !state.dependenciesPanelVisible })),

	showDependenciesPanel: () => set({ dependenciesPanelVisible: true }),

	showUtilityPanel: (tab) => set({ utilityPanelVisible: true, activeUtilityTab: tab }),

	setColorScheme: (scheme) => set({ colorScheme: scheme }),

	setEditorFont: (font) => set({ editorFont: font }),

	setAppearanceModalOpen: (open) => set({ isAppearanceModalOpen: open }),

	setActiveMobilePanel: (panel) => set({ activeMobilePanel: panel }),

	toggleMobileFileTree: () => set((state) => ({ mobileFileTreeOpen: !state.mobileFileTreeOpen })),

	setActiveSidebarView: (view) => set({ activeSidebarView: view }),
});
