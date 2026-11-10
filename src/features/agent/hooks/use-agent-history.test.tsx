import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentHistory } from './use-agent-history';

import type { AgentMessage } from '@shared/agent-chat';
import type { ReactNode } from 'react';

const mocks = vi.hoisted(() => ({ history: vi.fn() }));
vi.mock('@/lib/api-client', () => ({
	createApiClient: () => ({ agent: { sessions: { ':sessionId': { history: { $get: mocks.history } } } } }),
}));

function message(id: string, role: AgentMessage['role'] = 'assistant', submissionId?: string): AgentMessage {
	return { id, role, parts: [{ type: 'text', text: id }], metadata: submissionId ? { submissionId } : undefined };
}
function wrapper({ children }: { children: ReactNode }) {
	return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>;
}
beforeEach(() => vi.resetAllMocks());

describe('original transcript paging and SDK streaming', () => {
	it('pages original rows in order without injecting the older hydrated SDK rows or compaction summaries', async () => {
		const rows = Array.from({ length: 60 }, (_, index) => message(String(index + 1)));
		mocks.history.mockResolvedValueOnce(Response.json({ messages: rows.slice(10), before: '11' }));
		mocks.history.mockResolvedValueOnce(Response.json({ messages: rows.slice(0, 10) }));
		const { result } = renderHook(() => useAgentHistory('project', 'session', rows.at(-1), false), { wrapper });
		await waitFor(() => expect(result.current.messages.map((item) => item.id)).toEqual(rows.slice(10).map((item) => item.id)));
		await act(() => result.current.loadEarlier());
		await waitFor(() => expect(result.current.messages.map((item) => item.id)).toEqual(rows.map((item) => item.id)));
		mocks.history.mockResolvedValueOnce(Response.json({ messages: rows.slice(10), before: '11' }));
		const summary = message('__compaction:summary');
		const compacted = renderHook(() => useAgentHistory('project', 'compacted', summary, true), { wrapper });
		await waitFor(() => expect(compacted.result.current.messages).toHaveLength(50));
		expect(compacted.result.current.messages.some((item) => item.id === summary.id)).toBe(false);
	});
	it('uses the SDK live assistant once, then displays its persisted original after completion', async () => {
		const user = message('user', 'user');
		const assistant = message('answer', 'assistant', 'submission');
		mocks.history.mockResolvedValueOnce(Response.json({ messages: [user] }));
		const { result, rerender } = renderHook(({ streaming }) => useAgentHistory('project', 'session', assistant, streaming), {
			wrapper,
			initialProps: { streaming: true },
		});
		await waitFor(() => expect(result.current.messages).toEqual([user, assistant]));
		rerender({ streaming: false });
		expect(result.current.messages).toEqual([user]);
		mocks.history.mockResolvedValueOnce(Response.json({ messages: [user, assistant] }));
		const persisted = renderHook(() => useAgentHistory('project', 'persisted', assistant, true), { wrapper });
		await waitFor(() => expect(persisted.result.current.messages).toEqual([user, assistant]));
	});
	it('drops paged branch rows and aborts stale reads when another client changes the active SDK tail', async () => {
		const oldAnswer = message('old-answer');
		const newAnswer = message('new-answer', 'assistant', 'native-regeneration');
		mocks.history.mockResolvedValueOnce(Response.json({ messages: [oldAnswer], before: 'old-answer' }));
		const { result, rerender } = renderHook(({ latest }) => useAgentHistory('project', 'session', latest, false), {
			wrapper,
			initialProps: { latest: oldAnswer },
		});
		await waitFor(() => expect(result.current.messages).toEqual([oldAnswer]));
		const older = Promise.withResolvers<Response>();
		let olderSignal: AbortSignal | undefined;
		mocks.history.mockImplementationOnce((_input: unknown, options: { init: { signal: AbortSignal } }) => {
			olderSignal = options.init.signal;
			return older.promise;
		});
		mocks.history.mockResolvedValueOnce(Response.json({ messages: [newAnswer] }));
		let loading: Promise<unknown> | undefined;
		act(() => {
			loading = result.current.loadEarlier();
		});
		rerender({ latest: newAnswer });
		await waitFor(() => expect(result.current.messages).toEqual([newAnswer]));
		await act(async () => {
			older.resolve(Response.json({ messages: [message('stale-branch')] }));
			await loading;
		});
		expect(result.current.messages).toEqual([newAnswer]);
		expect(olderSignal?.aborted).toBe(true);
	});
});
