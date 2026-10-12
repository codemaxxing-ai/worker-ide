import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { previewIframeReference } from '@/features/preview/preview-iframe-reference';

import { PreviewPanel } from './preview-panel';

import type { ReactNode } from 'react';

const mockStartPreviewElementPicker = vi.fn(() => true);
const mockCancelPreviewElementPicker = vi.fn(() => true);
const mockToggleDevtools = vi.fn();
const mockQueuePreviewElementReference = vi.fn();
const mockShowAgentPanel = vi.fn();

vi.mock('@/components/ui/loading-bars', () => ({
	LoadingBars: () => <div data-testid="loading-bars" />,
}));

vi.mock('@/components/ui/tooltip', () => ({
	Tooltip: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('@/features/preview/preview-iframe-reference', () => ({
	cancelPreviewElementPicker: () => mockCancelPreviewElementPicker(),
	startPreviewElementPicker: () => mockStartPreviewElementPicker(),
	previewIframeReference: { current: undefined },
	previewOriginReference: { current: undefined },
}));

vi.mock('@/lib/store', () => ({
	useStore: (selector: (state: Record<string, unknown>) => unknown) =>
		selector({
			devtoolsVisible: false,
			toggleDevtools: mockToggleDevtools,
			queuePreviewElementReference: mockQueuePreviewElementReference,
			showAgentPanel: mockShowAgentPanel,
		}),
}));

function createIframeReference() {
	const iframe = document.createElement('iframe');
	return { iframeReference: { current: iframe } };
}

function renderPreviewPanel(options?: { refreshPreviewUrl?: () => Promise<string | undefined> }) {
	const { iframeReference } = createIframeReference();
	return render(
		<PreviewPanel
			previewUrl="https://example.com"
			previewOrigin="https://example.com"
			isLoadingUrl={false}
			refreshPreviewUrl={options?.refreshPreviewUrl ?? vi.fn(async () => 'https://example.com')}
			iframeReference={iframeReference}
		/>,
	);
}

describe('PreviewPanel', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('turns the picker off when the toggle button is clicked again', async () => {
		const user = userEvent.setup();
		renderPreviewPanel();

		const pickerButton = screen.getByRole('button', { name: 'Send to Agent' });

		await user.click(pickerButton);
		expect(mockStartPreviewElementPicker).toHaveBeenCalledOnce();
		expect(pickerButton.className).toContain('bg-accent/10');

		await user.click(pickerButton);
		expect(mockCancelPreviewElementPicker).toHaveBeenCalledOnce();
		expect(pickerButton.className).not.toContain('bg-accent/10');
	});

	it('turns the picker off when clicking outside the iframe', async () => {
		const user = userEvent.setup();
		renderPreviewPanel();

		const pickerButton = screen.getByRole('button', { name: 'Send to Agent' });

		await user.click(pickerButton);
		expect(pickerButton.className).toContain('bg-accent/10');

		fireEvent.pointerDown(document.body);
		expect(mockCancelPreviewElementPicker).toHaveBeenCalledOnce();
		expect(pickerButton.className).not.toContain('bg-accent/10');
	});

	it('opens external preview with noopener and noreferrer', async () => {
		const user = userEvent.setup();
		const mockWindow: Window = globalThis.window;
		const openSpy = vi.spyOn(globalThis, 'open').mockImplementation(() => mockWindow);
		renderPreviewPanel();

		await user.click(screen.getByRole('button', { name: 'Open in new tab' }));

		expect(openSpy).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
	});

	it('refreshes the signed preview URL from the header button', async () => {
		const user = userEvent.setup();
		const refreshPreviewUrl = vi.fn(async () => 'https://example.com');

		renderPreviewPanel({ refreshPreviewUrl });

		await user.click(screen.getByRole('button', { name: 'Refresh' }));

		await waitFor(() => {
			expect(refreshPreviewUrl).toHaveBeenCalledOnce();
		});
	});

	it('keeps message routing attached to the current iframe after a refresh', async () => {
		const user = userEvent.setup();
		renderPreviewPanel();
		const previousIframe = screen.getByTitle('Project Preview');
		await user.click(screen.getByRole('button', { name: 'Refresh' }));
		const currentIframe = screen.getByTitle('Project Preview');
		expect(currentIframe).not.toBe(previousIframe);
		expect(previewIframeReference.current).toBe(currentIframe);
	});

	it('only refreshes when preview-expired comes from the active preview origin', () => {
		const refreshPreviewUrl = vi.fn(async () => 'https://example.com');
		const { iframeReference } = createIframeReference();
		render(
			<PreviewPanel
				previewUrl="https://example.com"
				previewOrigin="https://example.com"
				isLoadingUrl={false}
				refreshPreviewUrl={refreshPreviewUrl}
				iframeReference={iframeReference}
			/>,
		);
		const previewWindow = iframeReference.current?.contentWindow;
		expect(previewWindow).toBeDefined();

		globalThis.dispatchEvent(
			new MessageEvent('message', {
				origin: 'https://attacker.example.com',
				source: previewWindow,
				data: { type: '__preview-expired' },
			}),
		);
		expect(refreshPreviewUrl).not.toHaveBeenCalled();

		globalThis.dispatchEvent(
			new MessageEvent('message', {
				origin: 'https://example.com',
				source: previewWindow,
				data: { type: '__preview-expired' },
			}),
		);
		expect(refreshPreviewUrl).toHaveBeenCalledOnce();
	});
	it('bounds authentication refreshes and offers a standalone preview when cookies are rejected', async () => {
		const refreshPreviewUrl = vi.fn(async () => 'https://example.com');
		renderPreviewPanel({ refreshPreviewUrl });
		const iframe = screen.getByTitle('Project Preview');
		if (!(iframe instanceof HTMLIFrameElement)) throw new Error('Expected preview iframe');
		const send = (type: string, source = iframe.contentWindow, origin = 'https://example.com') => {
			void act(() => globalThis.dispatchEvent(new MessageEvent('message', { source, origin, data: { type } })));
		};
		send('__preview-access-required', globalThis.window);
		send('__preview-access-required', iframe.contentWindow, 'https://sibling.example.com');
		expect(refreshPreviewUrl).not.toHaveBeenCalled();
		send('__preview-access-required');
		send('__preview-access-required');
		expect(refreshPreviewUrl).toHaveBeenCalledOnce();
		expect(await screen.findByRole('button', { name: 'Open preview' })).toBeVisible();
		send('__chobitsu-ready');
		expect(screen.queryByRole('button', { name: 'Open preview' })).not.toBeInTheDocument();
		send('__preview-access-blocked');
		expect(screen.getByRole('button', { name: 'Open preview' })).toBeVisible();
		expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer');
	});
});
