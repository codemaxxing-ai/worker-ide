import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import { previewTransitionScript } from '../worker/lib/preview-transition-script';

function setup() {
	const listeners = new Map<string, (event: unknown) => void>();
	const window = { addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener) };
	const reload = vi.fn();
	const save = vi.fn();
	runInNewContext(
		previewTransitionScript({ backend: 'container', reason: 'explicit-choice', generation: 2 }, 'https://ide.test', 'project'),
		{
			window,
			parent: window,
			location: { pathname: '/', search: '', reload },
			document: { readyState: 'loading', querySelectorAll: () => [] },
			sessionStorage: { setItem: save },
			scrollX: 0,
			scrollY: 0,
			TextEncoder,
		},
	);
	return {
		reload,
		save,
		message: (generation: number, origin = 'https://ide.test') =>
			listeners.get('message')?.({ source: window, origin, data: { type: '__preview-runtime-switch', backend: 'container', generation } }),
		broadcast: (generation: number) =>
			listeners.get('__preview-runtime-status')?.({ detail: { preview: { backend: 'container', phase: 'ready', generation } } }),
	};
}

describe('preview restart handover', () => {
	it('captures state and reloads once for a newer generation of the same runtime', () => {
		const preview = setup();
		preview.message(3);
		expect(preview.reload).toHaveBeenCalledOnce();
		expect(preview.save).toHaveBeenCalledWith('__worker_ide_handover:project', expect.stringContaining('"previousGeneration":2'));
		preview.message(4);
		expect(preview.reload).toHaveBeenCalledOnce();
	});
	it('rejects stale, invalid and foreign transitions while accepting shared status updates', () => {
		const preview = setup();
		for (const generation of [1, 2, 2.5, Number.NaN]) preview.message(generation);
		preview.message(3, 'https://untrusted.test');
		expect(preview.reload).not.toHaveBeenCalled();
		preview.broadcast(3);
		expect(preview.reload).toHaveBeenCalledOnce();
	});
});
