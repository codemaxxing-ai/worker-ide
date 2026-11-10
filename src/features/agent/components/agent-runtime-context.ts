import { createContext, useContext } from 'react';

import type { InputSegment } from '../lib/input-segments';
import type { AgentState } from '@shared/agent-state';
import type { Dispatch, SetStateAction } from 'react';

export type AgentConnectionState = 'connecting' | 'connected' | 'disconnected';

export interface ImageAttachment {
	id: string;
	name: string;
	status: 'uploading' | 'ready' | 'error';
	/** Local object URL used for immediate preview while uploading. */
	previewUrl: string;
	/** Optimized base64 data URL, available once status is 'ready'. */
	url?: string;
	mediaType?: string;
	error?: string;
}

export interface AgentRuntimeHandle {
	identified: boolean;
	state: AgentState | undefined;
	addEventListener: (type: string, listener: () => void) => void;
	removeEventListener: (type: string, listener: () => void) => void;
}

export interface AgentRuntimeValue {
	agent: AgentRuntimeHandle;
	activeSessionId?: string;
	selectSession: (id?: string) => void;
	agentConnectionState: AgentConnectionState;
	isConnected: boolean;
	segments: InputSegment[];
	setSegments: Dispatch<SetStateAction<InputSegment[]>>;
	cursorPosition: number;
	setCursorPosition: Dispatch<SetStateAction<number>>;
	imageAttachments: ImageAttachment[];
	setImageAttachments: Dispatch<SetStateAction<ImageAttachment[]>>;
}

export const AgentRuntimeContext = createContext<AgentRuntimeValue | undefined>(undefined);

export function useAgentRuntime(): AgentRuntimeValue {
	const value = useContext(AgentRuntimeContext);
	if (!value) {
		throw new Error('useAgentRuntime must be used within AgentRuntimeProvider');
	}

	return value;
}
