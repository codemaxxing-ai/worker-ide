import type { StoreState } from '@/lib/store';
import type { Participant } from '@shared/types';
import type { StateCreator } from 'zustand';

export interface CollaborationState {
	participants: Participant[];
	localParticipantId: string | undefined;
	localParticipantColor: string | undefined;
	isConnected: boolean;
}

export interface CollaborationActions {
	setParticipants: (participants: Participant[]) => void;
	addParticipant: (participant: Participant) => void;
	removeParticipant: (id: string) => void;
	updateParticipant: (id: string, updates: Partial<Participant>) => void;
	setLocalParticipantId: (id: string) => void;
	setLocalParticipantColor: (color: string) => void;
	setConnected: (connected: boolean) => void;
}

export const createCollaborationSlice: StateCreator<
	StoreState,
	[['zustand/devtools', never]],
	[],
	CollaborationState & CollaborationActions
> = (set) => ({
	participants: [],
	localParticipantId: undefined,
	localParticipantColor: undefined,
	isConnected: false,

	setParticipants: (participants) => set({ participants }),

	addParticipant: (participant) =>
		set((state) => ({
			participants: [...state.participants, participant],
		})),

	removeParticipant: (id) =>
		set((state) => ({
			participants: state.participants.filter((p) => p.id !== id),
		})),

	updateParticipant: (id, updates) =>
		set((state) => ({
			participants: state.participants.map((p) => (p.id === id ? { ...p, ...updates } : p)),
		})),

	setLocalParticipantId: (id) => set({ localParticipantId: id }),

	setLocalParticipantColor: (color) => set({ localParticipantColor: color }),

	setConnected: (connected) => set({ isConnected: connected }),
});
