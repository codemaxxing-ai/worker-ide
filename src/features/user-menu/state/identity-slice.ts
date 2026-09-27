import type { StoreState } from '@/lib/store';
import type { StateCreator } from 'zustand';

export interface IdentityState {
	optimisticUserName: string | undefined;
	optimisticOrganizationNames: Record<string, string>;
}

export interface IdentityActions {
	setOptimisticUserName: (name: string | undefined) => void;
	setOptimisticOrganizationName: (organizationId: string, name: string | undefined) => void;
}

export const createIdentitySlice: StateCreator<StoreState, [['zustand/devtools', never]], [], IdentityState & IdentityActions> = (set) => ({
	optimisticUserName: undefined,
	optimisticOrganizationNames: {},

	setOptimisticUserName: (name) => set({ optimisticUserName: name }),

	setOptimisticOrganizationName: (organizationId, name) =>
		set((state) => {
			const optimisticOrganizationNames = { ...state.optimisticOrganizationNames };
			if (name === undefined) {
				delete optimisticOrganizationNames[organizationId];
			} else {
				optimisticOrganizationNames[organizationId] = name;
			}
			return { optimisticOrganizationNames };
		}),
});
