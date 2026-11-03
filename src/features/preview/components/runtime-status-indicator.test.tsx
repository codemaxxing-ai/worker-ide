import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { emptyRuntimeStatus } from '@shared/runtime-status';

import { RuntimeStatusIndicator } from './runtime-status-indicator';

import type { ReactNode } from 'react';

const fromPreview = vi.fn(() => true);
vi.mock('@/lib/preview-origin', () => ({ isMessageFromPreview: () => fromPreview() }));
vi.mock('@/components/ui/tooltip', () => ({ Tooltip: ({ children }: { children: ReactNode }) => children }));

function message(backend: string, generation = backend === 'container' ? 2 : 1) {
	act(() => {
		globalThis.dispatchEvent(new MessageEvent('message', { data: { type: '__preview-runtime-ready', backend, generation } }));
	});
}

function setup() {
	const status = {
		...emptyRuntimeStatus(),
		preview: { backend: 'worker', target: 'worker', phase: 'ready', reason: 'simple-project', generation: 1 },
		revision: 1,
	};
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => Response.json(status)),
	);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	const iframe = document.createElement('iframe');
	document.body.append(iframe);
	const window = iframe.contentWindow;
	if (!window) throw new Error('Missing preview browsing context');
	const send = vi.spyOn(window, 'postMessage');
	render(
		<QueryClientProvider client={client}>
			<RuntimeStatusIndicator projectId="project" previewOrigin="https://preview.test" iframeReference={{ current: iframe }} />
		</QueryClientProvider>,
	);
	return { client, send, iframe };
}

describe('Preview runtime toolbar', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		fromPreview.mockReturnValue(true);
		for (const iframe of document.querySelectorAll('iframe')) iframe.remove();
	});
	it('shows the serving runtime during handover and switches only after readiness', async () => {
		const { client, send } = setup();
		await screen.findByRole('status', { name: 'Worker' });
		message('worker');
		const preview = { backend: 'worker', target: 'container', phase: 'switching', reason: 'resource-limit', generation: 2 };
		act(() => {
			client.setQueryData(['runtime-status', 'project'], { ...emptyRuntimeStatus(), preview, revision: 2 });
		});
		await screen.findByRole('status', { name: 'Worker → Container starting' });
		expect(send).not.toHaveBeenCalled();
		act(() => {
			client.setQueryData(['runtime-status', 'project'], {
				...emptyRuntimeStatus(),
				preview: { ...preview, backend: 'container', phase: 'ready' },
				revision: 3,
			});
		});
		await waitFor(() =>
			expect(send).toHaveBeenCalledWith({ type: '__preview-runtime-switch', backend: 'container' }, 'https://preview.test'),
		);
		message('container');
		await screen.findByRole('status', { name: 'Container' });
		message('worker', 1);
		expect(screen.getByRole('status', { name: 'Container' })).toBeInTheDocument();
	});
	it('ignores foreign ready messages and an older HTTP status', async () => {
		const { client } = setup();
		await screen.findByRole('status', { name: 'Worker' });
		fromPreview.mockReturnValue(false);
		message('container');
		expect(screen.getByRole('status', { name: 'Worker' })).toBeInTheDocument();
		act(() => {
			client.setQueryData(['runtime-status', 'project'], {
				...emptyRuntimeStatus(),
				preview: { backend: 'container', phase: 'ready', generation: 2 },
				revision: 9,
			});
		});
		await screen.findByRole('status', { name: 'Container' });
		await act(() => client.refetchQueries({ queryKey: ['runtime-status', 'project'] }));
		expect(screen.getByRole('status', { name: 'Container' })).toBeInTheDocument();
	});
	it('shows icons without visible runtime text and switches through the typed endpoint', async () => {
		const user = userEvent.setup();
		setup();
		const status = await screen.findByRole('status', { name: 'Worker' });
		expect(status.textContent).toBe('');
		expect(status.querySelector('svg')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Runtime: Worker' }));
		await user.click(await screen.findByRole('menuitem', { name: 'Switch to container' }));
		await waitFor(() =>
			expect(fetch).toHaveBeenCalledWith(
				expect.stringContaining('/runtime/switch-to-container'),
				expect.objectContaining({ method: 'POST' }),
			),
		);
	});
	it('offers retry at capacity and never offers a reverse switch', async () => {
		const user = userEvent.setup();
		const { client } = setup();
		await screen.findByRole('status', { name: 'Worker' });
		await act(() =>
			client.setQueryData(['runtime-status', 'project'], {
				...emptyRuntimeStatus(),
				revision: 2,
				preview: {
					backend: 'worker',
					target: 'container',
					phase: 'blocked',
					generation: 2,
					capacity: { currentRunningContainers: 3, maxRunningContainers: 3 },
				},
			}),
		);
		await user.click(await screen.findByRole('button', { name: 'Runtime: Worker container limit reached' }));
		expect(await screen.findByRole('menuitem', { name: 'Retry container' })).toBeEnabled();
		expect(screen.getByText('Containers: 3/3')).toBeInTheDocument();
		await user.keyboard('{Escape}');
		await act(() =>
			client.setQueryData(['runtime-status', 'project'], {
				...emptyRuntimeStatus(),
				revision: 3,
				preview: { backend: 'container', phase: 'ready', generation: 3 },
			}),
		);
		await user.click(await screen.findByRole('button', { name: 'Runtime: Container' }));
		expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
	});
});
