import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
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
});
