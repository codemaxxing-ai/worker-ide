import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useStore } from '@/lib/store';

import { useProjectSocket } from './use-project-socket';

import type { ReactNode } from 'react';

class FakeWebSocket extends EventTarget {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: FakeWebSocket[] = [];

	readonly sentMessages: string[] = [];
	readyState = FakeWebSocket.CONNECTING;

	constructor(readonly url: string) {
		super();
		FakeWebSocket.instances.push(this);
	}

	send(message: string): void {
		this.sentMessages.push(message);
	}

	close(code = 1000, reason = ''): void {
		this.readyState = FakeWebSocket.CLOSED;
		this.dispatchEvent(new CloseEvent('close', { code, reason }));
	}

	open(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.dispatchEvent(new Event('open'));
	}

	message(data: string): void {
		this.dispatchEvent(new MessageEvent('message', { data }));
	}
}

function createWrapper(queryClient: QueryClient) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
	};
}

describe('useProjectSocket', () => {
	beforeEach(() => {
		FakeWebSocket.instances = [];
		vi.stubGlobal('WebSocket', FakeWebSocket);
		useStore.setState({
			participants: [],
			pendingChanges: new Map(),
			gitDiffView: undefined,
			activeFile: undefined,
			unsavedChanges: new Map(),
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('applies incoming file edits to the file cache and participant cursor', async () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		queryClient.setQueryData(['file', 'project-1', '/src/app.ts'], { path: '/src/app.ts', content: 'old content' });
		useStore.setState({ participants: [{ id: 'other-client', color: '#f97316' }] });

		const { unmount } = renderHook(() => useProjectSocket({ projectId: 'project-1' }), { wrapper: createWrapper(queryClient) });

		expect(FakeWebSocket.instances).toHaveLength(1);
		const socket = FakeWebSocket.instances[0];
		expect(socket).toBeDefined();
		socket?.open();
		socket?.message(
			JSON.stringify({
				type: 'file-edited',
				id: 'other-client',
				path: '/src/app.ts',
				content: 'new content',
				cursor: { line: 3, ch: 7 },
				selection: { anchor: { line: 3, ch: 1 }, head: { line: 3, ch: 7 } },
			}),
		);

		expect(queryClient.getQueryData(['file', 'project-1', '/src/app.ts'])).toEqual({ path: '/src/app.ts', content: 'new content' });
		expect(useStore.getState().participants).toEqual([
			{
				id: 'other-client',
				color: '#f97316',
				file: '/src/app.ts',
				cursor: { line: 3, ch: 7 },
				selection: { anchor: { line: 3, ch: 1 }, head: { line: 3, ch: 7 } },
			},
		]);

		unmount();
	});

	it('preserves agent diff state when incoming human edits update the live file', async () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		useStore.setState({
			pendingChanges: new Map([
				[
					'/src/app.ts',
					{
						path: '/src/app.ts',
						action: 'edit',
						beforeContent: 'const value = 1;',
						afterContent: 'const value = 2;',
						snapshotId: undefined,
						status: 'pending',
						hunkStatuses: ['pending'],
						sessionId: 'session-1',
					},
				],
			]),
			gitDiffView: {
				path: '/src/app.ts',
				beforeContent: 'const value = 1;',
				afterContent: 'const value = 2;',
			},
		});

		const { unmount } = renderHook(() => useProjectSocket({ projectId: 'project-1' }), { wrapper: createWrapper(queryClient) });

		expect(FakeWebSocket.instances).toHaveLength(1);
		const socket = FakeWebSocket.instances[0];
		expect(socket).toBeDefined();
		socket?.open();
		socket?.message(
			JSON.stringify({
				type: 'file-edited',
				id: 'other-client',
				path: '/src/app.ts',
				content: 'const value = 3;',
			}),
		);

		expect(queryClient.getQueryData(['file', 'project-1', '/src/app.ts'])).toEqual({ path: '/src/app.ts', content: 'const value = 3;' });
		expect(useStore.getState().pendingChanges.get('/src/app.ts')?.afterContent).toBe('const value = 2;');
		expect(useStore.getState().pendingChanges.get('/src/app.ts')?.hunkStatuses).toEqual(['pending']);
		expect(useStore.getState().gitDiffView?.afterContent).toBe('const value = 3;');

		unmount();
	});

	it('sends heartbeat pings and keeps the connection open when pong is received', async () => {
		vi.useFakeTimers();
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

		const { unmount } = renderHook(() => useProjectSocket({ projectId: 'project-1' }), { wrapper: createWrapper(queryClient) });

		expect(FakeWebSocket.instances).toHaveLength(1);
		const socket = FakeWebSocket.instances[0];
		expect(socket).toBeDefined();
		socket?.open();

		void act(() => vi.advanceTimersByTime(30_000));
		expect(socket?.sentMessages).toContain(JSON.stringify({ type: 'ping' }));

		socket?.message(JSON.stringify({ type: 'pong' }));
		void act(() => vi.advanceTimersByTime(30_000));

		expect(socket?.readyState).toBe(FakeWebSocket.OPEN);
		unmount();
	});

	it('closes and schedules reconnect when heartbeat pong is missing', async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, 'random').mockReturnValue(0);
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

		const { unmount } = renderHook(() => useProjectSocket({ projectId: 'project-1' }), { wrapper: createWrapper(queryClient) });

		expect(FakeWebSocket.instances).toHaveLength(1);
		const socket = FakeWebSocket.instances[0];
		expect(socket).toBeDefined();
		socket?.open();

		void act(() => vi.advanceTimersByTime(120_000));
		expect(socket?.readyState).toBe(FakeWebSocket.CLOSED);

		void act(() => vi.advanceTimersByTime(2000));
		expect(FakeWebSocket.instances).toHaveLength(2);
		unmount();
	});

	it('invalidates every cached file after reconnect, including the active file', async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, 'random').mockReturnValue(0);
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
		queryClient.setQueryData(['file', 'project-1', '/src/active.ts'], { path: '/src/active.ts', content: 'active' });
		queryClient.setQueryData(['file', 'project-1', '/src/inactive.ts'], { path: '/src/inactive.ts', content: 'inactive' });
		useStore.setState({ activeFile: '/src/active.ts' });

		const { unmount } = renderHook(() => useProjectSocket({ projectId: 'project-1' }), { wrapper: createWrapper(queryClient) });

		expect(FakeWebSocket.instances).toHaveLength(1);
		FakeWebSocket.instances[0]?.open();
		FakeWebSocket.instances[0]?.close(1011, 'network');
		void act(() => vi.advanceTimersByTime(2000));
		FakeWebSocket.instances[1]?.open();

		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['files', 'project-1'] });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['file', 'project-1', '/src/inactive.ts'], exact: true });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['file', 'project-1', '/src/active.ts'], exact: true });
		unmount();
	});

	it('invalidates the active file content on an incoming update (agent write)', async () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
		useStore.setState({ activeFile: '/src/active.ts' });

		const { unmount } = renderHook(() => useProjectSocket({ projectId: 'project-1' }), { wrapper: createWrapper(queryClient) });

		const socket = FakeWebSocket.instances[0];
		socket?.open();
		socket?.message(
			JSON.stringify({
				type: 'update',
				version: 1,
				updates: [{ type: 'update', path: '/src/active.ts', timestamp: Date.now(), targets: [] }],
			}),
		);

		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['file', 'project-1', '/src/active.ts'] });
		unmount();
	});
});
