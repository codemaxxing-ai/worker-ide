import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_AI_MODEL } from '@shared/constants';

import { useAgentSessions } from './use-agent-sessions';

import type { AgentState } from '@shared/agent-state';
import type { ReactNode } from 'react';

const mocks = vi.hoisted(() => {
	const state: { value?: AgentState } = {};
	return {
		selectSession: vi.fn(),
		rename: vi.fn(),
		remove: vi.fn(),
		search: vi.fn(),
		state,
	};
});
vi.mock('../components/agent-runtime-context', () => ({
	useAgentRuntime: () => ({ agent: { state: mocks.state.value }, activeSessionId: 'first', selectSession: mocks.selectSession }),
}));
vi.mock('@/lib/api-client', () => ({
	createApiClient: () => ({
		agent: {
			ready: true,
			sessions: {
				search: { $get: mocks.search },
				':sessionId': { title: { $put: mocks.rename }, $delete: mocks.remove },
			},
		},
	}),
}));
function wrapper({ children }: { children: ReactNode }) {
	return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>;
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.state.value = {
		ready: true,
		sessions: ['first', 'second'].map((id) => ({
			id,
			title: id,
			createdAt: 1,
			updatedAt: 1,
			model: DEFAULT_AI_MODEL,
			mode: 'code',
			status: 'idle',
			isRunning: false,
			revision: 0,
		})),
		reviewEntries: {},
		reviewSummary: { unresolvedCount: 0, reviewVersion: 0, sessionCounts: {} },
	};
	mocks.remove.mockResolvedValue(Response.json({ success: true }));
	mocks.rename.mockResolvedValue(Response.json({ success: true }));
	mocks.search.mockResolvedValue(Response.json({ matches: [{ sessionId: 'second', messageId: 'found', content: 'needle' }] }));
});
describe('session directory commands', () => {
	it('clears only this tab selection after deleting its selected session', async () => {
		const { result } = renderHook(() => useAgentSessions('project'), { wrapper });
		await act(() => result.current.deleteSession('first'));
		expect(mocks.remove).toHaveBeenCalledWith({ param: { sessionId: 'first' } });
		expect(mocks.selectSession).toHaveBeenCalledWith();
	});
	it('preserves selection when deletion fails or another session is deleted', async () => {
		const { result } = renderHook(() => useAgentSessions('project'), { wrapper });
		await act(() => result.current.deleteSession('second'));
		mocks.remove.mockResolvedValue(Response.json({ error: 'Failed' }, { status: 500 }));
		await expect(result.current.deleteSession('first')).rejects.toThrow();
		expect(mocks.selectSession).not.toHaveBeenCalled();
	});
	it('searches transcript content through the typed API without selecting a session', async () => {
		const { result } = renderHook(() => useAgentSessions('project'), { wrapper });
		act(() => result.current.setQuery('needle'));
		await waitFor(() => expect(result.current.sessions.map((session) => session.id)).toEqual(['second']));
		expect(mocks.selectSession).not.toHaveBeenCalled();
	});
	it('renames through the directory without modifying local transcripts', async () => {
		const { result } = renderHook(() => useAgentSessions('project'), { wrapper });
		await act(() => result.current.renameSession('first', 'Updated'));
		expect(mocks.rename).toHaveBeenCalledWith({ param: { sessionId: 'first' }, json: { title: 'Updated' } });
	});
});
