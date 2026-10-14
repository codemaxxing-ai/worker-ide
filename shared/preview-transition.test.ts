import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

import { previewTransitionScript } from '../worker/lib/preview-transition-script';

describe('preview state handover', () => {
	it('restores app state and ordinary fields without restoring secret inputs', async () => {
		const dom = new JSDOM('<input id="title"><input id="secret" type="password"><input id="checked" type="checkbox">', {
			url: 'https://preview.test/path?q=1#fragment',
			runScripts: 'dangerously',
			pretendToBeVisual: true,
		});
		const ready = vi.fn();
		Reflect.set(dom.window, 'TextEncoder', TextEncoder);
		Object.defineProperty(dom.window, 'parent', { value: { postMessage: ready } });
		const restore = vi.fn();
		Reflect.set(dom.window, '__WORKER_IDE_PREVIEW_STATE__', { restore });
		dom.window.scrollTo = vi.fn();
		dom.window.sessionStorage.setItem(
			'__worker_ide_handover:project',
			JSON.stringify({
				backend: 'container',
				path: '/path?q=1',
				timestamp: Date.now() - 90_000,
				application: { counter: 7 },
				scrollX: 0,
				scrollY: 25,
				fields: [
					{ id: 'title', tag: 'INPUT', type: 'text', value: 'Retained draft', focused: true },
					{ id: 'secret', tag: 'INPUT', type: 'password', value: 'Do not restore' },
					{ id: 'checked', tag: 'INPUT', type: 'checkbox', value: 'on', checked: true },
				],
			}),
		);
		dom.window.eval(
			previewTransitionScript({ backend: 'container', reason: 'resource-limit', generation: 2 }, 'https://ide.test', 'project'),
		);
		await vi.waitFor(() =>
			expect(ready).toHaveBeenCalledWith({ type: '__preview-runtime-ready', backend: 'container', generation: 2 }, 'https://ide.test'),
		);
		expect(restore).toHaveBeenCalledWith({ counter: 7 });
		expect(dom.window.document.querySelector('#title')).toHaveProperty('value', 'Retained draft');
		expect(dom.window.document.querySelector('#secret')).toHaveProperty('value', '');
		expect(dom.window.document.querySelector('#checked')).toHaveProperty('checked', true);
		expect(dom.window.location.hash).toBe('#fragment');
		expect(dom.window.sessionStorage.getItem('__worker_ide_handover:project')).toBeNull();
		dom.window.close();
	});
	it('does not leave readiness stuck on malformed saved fields or a failing hook', async () => {
		const dom = new JSDOM('<input>', { url: 'https://preview.test/', runScripts: 'dangerously', pretendToBeVisual: true });
		const ready = vi.fn();
		Reflect.set(dom.window, 'TextEncoder', TextEncoder);
		Object.defineProperty(dom.window, 'parent', { value: { postMessage: ready } });
		Reflect.set(dom.window, '__WORKER_IDE_PREVIEW_STATE__', {
			restore: () => {
				throw new Error('Application failed');
			},
		});
		dom.window.sessionStorage.setItem(
			'__worker_ide_handover:project',
			JSON.stringify({ backend: 'container', path: '/', timestamp: Date.now(), fields: { invalid: true } }),
		);
		dom.window.eval(
			previewTransitionScript({ backend: 'container', reason: 'resource-limit', generation: 2 }, 'https://ide.test', 'project'),
		);
		await vi.waitFor(() => expect(ready).toHaveBeenCalled());
		dom.window.close();
	});
	it('captures an HMR reload and keeps fields when application state is circular', async () => {
		const worker = new JSDOM('<input id="draft" value="Retained">', {
			url: 'https://preview.test/',
			runScripts: 'dangerously',
			pretendToBeVisual: true,
		});
		Reflect.set(worker.window, 'TextEncoder', TextEncoder);
		Object.defineProperty(worker.window, 'parent', { value: { postMessage: vi.fn() } });
		const application: Record<string, unknown> = {};
		application.self = application;
		Reflect.set(worker.window, '__WORKER_IDE_PREVIEW_STATE__', { capture: () => application });
		worker.window.eval(
			previewTransitionScript({ backend: 'worker', reason: 'simple-project', generation: 1 }, 'https://ide.test', 'project'),
		);
		worker.window.dispatchEvent(new worker.window.Event('beforeunload'));
		const saved = worker.window.sessionStorage.getItem('__worker_ide_handover:project');
		if (!saved) throw new Error('Handover was not captured');
		worker.window.close();
		const native = new JSDOM('<input id="draft">', { url: 'https://preview.test/', runScripts: 'dangerously', pretendToBeVisual: true });
		Reflect.set(native.window, 'TextEncoder', TextEncoder);
		const ready = vi.fn();
		Object.defineProperty(native.window, 'parent', { value: { postMessage: ready } });
		native.window.scrollTo = vi.fn();
		native.window.sessionStorage.setItem('__worker_ide_handover:project', saved);
		native.window.eval(
			previewTransitionScript({ backend: 'container', reason: 'resource-limit', generation: 2 }, 'https://ide.test', 'project'),
		);
		await vi.waitFor(() => expect(ready).toHaveBeenCalled());
		expect(native.window.document.querySelector('#draft')).toHaveProperty('value', 'Retained');
		native.window.close();
	});
});
