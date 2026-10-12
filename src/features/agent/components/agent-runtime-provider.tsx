import { useAgent } from 'agents/react';
import { useEffect, useMemo, useState } from 'react';

import { AgentRuntimeContext } from './agent-runtime-context';
import { loadAgentDraftSession, saveAgentDraftSession } from '../lib/agent-draft-session';
import { segmentsToPlainText } from '../lib/input-segments';

import type { AgentRuntimeHandle, AgentRuntimeValue, ImageAttachment } from './agent-runtime-context';
import type { InputSegment } from '../lib/input-segments';
import type { AgentRunnerClient } from '@shared/agent-rpc';
import type { AgentState } from '@shared/agent-state';
import type { ReactNode } from 'react';

export function AgentRuntimeProvider({ projectId, children }: { projectId: string; children: ReactNode }) {
	const [segments, setSegments] = useState<InputSegment[]>(() => loadAgentDraftSession(projectId)?.segments ?? []);
	const [cursorPosition, setCursorPosition] = useState(() => loadAgentDraftSession(projectId)?.cursorPosition ?? 0);
	// Image attachments are transient (base64 is too large to persist to
	// localStorage) and reset when switching projects.
	const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([]);
	const rawAgent = useAgent<AgentRunnerClient, AgentState>({
		agent: 'AgentRunner',
		protocol: 'wss',
		// basePath connects to /p/{projectId}/__agent which the worker
		// entry point forwards to the AgentRunner DO.
		// Note: partysocket prepends a "/" when building the URL, so basePath
		// must NOT start with a slash — otherwise the URL becomes "//p/...".
		basePath: `p/${projectId}/__agent`,
	});
	const agent = useMemo<AgentRuntimeHandle>(
		() => ({
			get identified() {
				return rawAgent.identified;
			},
			get state() {
				return rawAgent.state;
			},
			get stub() {
				return rawAgent.stub;
			},
			addEventListener: (type, listener) => {
				rawAgent.addEventListener(type, listener);
			},
			removeEventListener: (type, listener) => {
				rawAgent.removeEventListener(type, listener);
			},
		}),
		[rawAgent],
	);
	const [agentConnectionState, setAgentConnectionState] = useState<'connecting' | 'connected' | 'disconnected'>(
		rawAgent.identified ? 'connected' : 'connecting',
	);

	useEffect(() => {
		const handleOpen = () => {
			setAgentConnectionState('connected');
		};
		const handleClose = () => {
			setAgentConnectionState('disconnected');
		};

		agent.addEventListener('open', handleOpen);
		agent.addEventListener('close', handleClose);
		return () => {
			agent.removeEventListener('open', handleOpen);
			agent.removeEventListener('close', handleClose);
		};
	}, [agent]);

	useEffect(() => {
		const draftLength = segmentsToPlainText(segments).length;
		saveAgentDraftSession(projectId, {
			segments,
			cursorPosition: Math.max(0, Math.min(cursorPosition, draftLength)),
		});
	}, [cursorPosition, projectId, segments]);

	const value: AgentRuntimeValue = {
		agent,
		agentConnectionState,
		isConnected: agentConnectionState === 'connected',
		segments,
		setSegments,
		cursorPosition,
		setCursorPosition,
		imageAttachments,
		setImageAttachments,
	};

	return <AgentRuntimeContext.Provider value={value}>{children}</AgentRuntimeContext.Provider>;
}
