import { DEFAULT_AI_MODEL } from '@shared/constants';

import type { StoreState } from '@/lib/store';
import type { AIModelId } from '@shared/constants';
import type { PreviewElementReference, AgentMode } from '@shared/types';
import type { StateCreator } from 'zustand';

/** Local preferences and composer references; Think owns all conversation state. */
export interface AgentState {
	agentMode: AgentMode;
	selectedModel: AIModelId;
	pendingPreviewElementReferences: PreviewElementReference[];
}
export interface AgentActions {
	setAgentMode: (mode: AgentMode) => void;
	setSelectedModel: (model: AIModelId) => void;
	queuePreviewElementReference: (reference: PreviewElementReference) => void;
	shiftPendingPreviewElementReference: () => void;
}
export const createAgentSlice: StateCreator<StoreState, [['zustand/devtools', never]], [], AgentState & AgentActions> = (set) => ({
	agentMode: 'code',
	selectedModel: DEFAULT_AI_MODEL,
	pendingPreviewElementReferences: [],
	setAgentMode: (agentMode) => set({ agentMode }),
	setSelectedModel: (selectedModel) => set({ selectedModel }),
	queuePreviewElementReference: (reference) =>
		set((state) => ({ pendingPreviewElementReferences: [...state.pendingPreviewElementReferences, reference] })),
	shiftPendingPreviewElementReference: () =>
		set((state) => ({ pendingPreviewElementReferences: state.pendingPreviewElementReferences.slice(1) })),
});
