import { DEFAULT_AI_MODEL } from '@shared/constants';

import type { StoreState } from '@/lib/store';
import type { AIModelId } from '@shared/constants';
import type { PreviewElementReference, AgentMode, ChatMessage } from '@shared/types';
import type { StateCreator } from 'zustand';

interface AgentError {
	message: string;
	code?: string;
}

export interface AgentState {
	history: ChatMessage[];
	isProcessing: boolean;
	statusMessage: string | undefined;
	agentError: AgentError | undefined;
	sessionId: string | undefined;
	savedSessions: Array<{ id: string; title: string; createdAt: number; isRunning: boolean }>;
	agentMode: AgentMode;
	selectedModel: AIModelId;
	debugLogId: string | undefined;
	contextTokensUsed: number;
	runningSessionIds: Set<string>;
	pendingPreviewElementReferences: PreviewElementReference[];
}

export interface AgentActions {
	addMessage: (message: ChatMessage) => void;
	clearHistory: () => void;
	setProcessing: (processing: boolean) => void;
	setStatusMessage: (message: string | undefined) => void;
	setAgentError: (error: AgentError | undefined) => void;
	setSessionId: (id: string | undefined) => void;
	setSavedSessions: (sessions: Array<{ id: string; title: string; createdAt: number; isRunning: boolean }>) => void;
	setAgentMode: (mode: AgentMode) => void;
	setSelectedModel: (model: AIModelId) => void;
	setDebugLogId: (id: string | undefined) => void;
	setContextTokensUsed: (tokens: number) => void;
	addRunningSession: (sessionId: string) => void;
	removeRunningSession: (sessionId: string) => void;
	setRunningSessionIds: (ids: Set<string>) => void;
	queuePreviewElementReference: (reference: PreviewElementReference) => void;
	shiftPendingPreviewElementReference: () => void;
}

export const createAgentSlice: StateCreator<StoreState, [['zustand/devtools', never]], [], AgentState & AgentActions> = (set) => ({
	history: [],
	isProcessing: false,
	statusMessage: undefined,
	agentError: undefined,
	sessionId: undefined,
	savedSessions: [],
	agentMode: 'code',
	selectedModel: DEFAULT_AI_MODEL,
	debugLogId: undefined,
	contextTokensUsed: 0,
	runningSessionIds: new Set(),
	pendingPreviewElementReferences: [],

	addMessage: (message) =>
		set((state) => ({
			history: [...state.history, message],
		})),

	clearHistory: () =>
		set({
			history: [],
			sessionId: undefined,
			agentError: undefined,
			debugLogId: undefined,
			contextTokensUsed: 0,
		}),

	setProcessing: (processing) => set({ isProcessing: processing }),

	setStatusMessage: (message) => set({ statusMessage: message }),

	setAgentError: (error) => set({ agentError: error }),

	setSessionId: (id) => set({ sessionId: id }),

	setSavedSessions: (sessions) => set({ savedSessions: sessions }),
	setAgentMode: (mode) => set({ agentMode: mode }),

	setSelectedModel: (model) => set({ selectedModel: model }),

	setDebugLogId: (id) => set({ debugLogId: id }),

	setContextTokensUsed: (tokens) => set({ contextTokensUsed: tokens }),

	addRunningSession: (sessionId) =>
		set((state) => {
			const next = new Set(state.runningSessionIds);
			next.add(sessionId);
			return { runningSessionIds: next };
		}),

	removeRunningSession: (sessionId) =>
		set((state) => {
			const next = new Set(state.runningSessionIds);
			next.delete(sessionId);
			return { runningSessionIds: next };
		}),

	setRunningSessionIds: (ids) => set({ runningSessionIds: ids }),

	queuePreviewElementReference: (reference) =>
		set((state) => ({ pendingPreviewElementReferences: [...state.pendingPreviewElementReferences, reference] })),

	shiftPendingPreviewElementReference: () =>
		set((state) => ({ pendingPreviewElementReferences: state.pendingPreviewElementReferences.slice(1) })),
});
