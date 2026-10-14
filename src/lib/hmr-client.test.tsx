import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import hmrClientSource from '@worker/lib/preview-scripts/hmr-client.js?raw';

const { default: previewRuntimeSource } = await import('@worker/lib/preview-scripts/preview-runtime.js?raw');

interface PreviewHotContext {
	readonly data: Record<string, unknown>;
	accept(
		dependenciesOrCallback?: string | string[] | ((moduleNamespace: unknown) => void),
		callback?: (moduleNamespace: unknown) => void,
	): void;
	acceptExports(exportNames: string | string[], callback?: (moduleNamespace: unknown) => void): void;
	dispose(callback: (data: Record<string, unknown>) => void): void;
	prune(callback: (data: Record<string, unknown>) => void): void;
	invalidate(message?: string): void;
	on(event: string, callback: (payload: unknown) => void): void;
	off(event: string, callback: (payload: unknown) => void): void;
	send(event: string, data?: unknown): void;
}

interface PreviewRuntimeApi {
	applyUpdate(update: {
		type: 'update';
		path: string;
		timestamp: number;
		targets: Array<{ id: string; kind: 'module' | 'style-link' }>;
	}): Promise<void>;
	hasModule(moduleId: string): boolean;
	registerModule(moduleId: string, importedModuleIds: string[]): void;
	createHotContext(moduleId: string): PreviewHotContext;
	upsertStyle(moduleId: string, cssText: string): void;
	emitEvent(event: string, payload: unknown): void;
}

function isPreviewRuntimeApi(value: unknown): value is PreviewRuntimeApi {
	return (
		typeof value === 'object' &&
		value !== undefined &&
		value !== null &&
		'applyUpdate' in value &&
		'hasModule' in value &&
		'registerModule' in value &&
		'createHotContext' in value
	);
}

class FakeWebSocket {
	static readonly OPEN = 1;
	static instances: FakeWebSocket[] = [];

	readonly listeners = new Map<string, Array<(event: { data?: string }) => void>>();
	readonly sentMessages: string[] = [];
	readyState = FakeWebSocket.OPEN;

	constructor(_url: string) {
		FakeWebSocket.instances.push(this);
	}

	addEventListener(type: string, listener: (event: { data?: string }) => void): void {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}

	send(message: string): void {
		this.sentMessages.push(message);
	}

	dispatch(type: string, event: { data?: string } = {}): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(event);
		}
	}

	static reset(): void {
		FakeWebSocket.instances = [];
	}
}

function flushPromises(): Promise<void> {
	return Promise.resolve().then(() => {});
}

function bootPreviewRuntime(): void {
	globalThis.eval(previewRuntimeSource);
}

function getPreviewRuntime(): PreviewRuntimeApi {
	const runtime = Reflect.get(globalThis, '__PREVIEW_RUNTIME__');
	if (!isPreviewRuntimeApi(runtime)) {
		throw new Error('Expected preview runtime to be available');
	}
	return runtime;
}

function bootHmrClient(bootVersion = 0): FakeWebSocket {
	Reflect.set(globalThis, '__PREVIEW_CONFIG', {
		wsUrl: 'ws://preview.test/__ws',
		ideOrigin: 'https://ide.test',
		projectId: 'project-1',
		bootVersion,
	});

	globalThis.eval(hmrClientSource);

	const socket = FakeWebSocket.instances.at(-1);
	if (socket === undefined) {
		throw new Error('Expected HMR client to open a WebSocket');
	}

	return socket;
}

describe('preview runtime and hmr transport', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		FakeWebSocket.reset();
		document.head.innerHTML = '';
		document.body.innerHTML = '';
		globalThis.history.replaceState(undefined, '', '/');
		vi.stubGlobal('WebSocket', FakeWebSocket);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		vi.useRealTimers();
		Reflect.deleteProperty(globalThis, '__PREVIEW_CONFIG');
		Reflect.deleteProperty(globalThis, '__PREVIEW_RUNTIME__');
		Reflect.deleteProperty(globalThis, '__PREVIEW_RUNTIME_IMPORT__');
		Reflect.deleteProperty(globalThis, '__PREVIEW_RUNTIME_RELOAD__');
		document.head.innerHTML = '';
		document.body.innerHTML = '';
	});

	it('forwards websocket updates to the preview runtime', async () => {
		const applyUpdate = vi.fn(async () => {});
		Reflect.set(globalThis, '__PREVIEW_RUNTIME__', { applyUpdate });

		const socket = bootHmrClient();
		const update = {
			type: 'update',
			path: '/src/style.css',
			timestamp: 123,
			targets: [{ id: '/src/style.css?mode=module', kind: 'module' }],
		};

		socket.dispatch('message', {
			data: JSON.stringify({
				type: 'update',
				version: 1,
				updates: [update],
			}),
		});

		await flushPromises();

		expect(applyUpdate).toHaveBeenCalledWith(update);
	});

	it('reloads without adding a hash fragment and reconnects using the injected boot version', () => {
		globalThis.history.replaceState(undefined, '', '/preview?view=split');
		const reloadSpy = vi.fn();
		Reflect.set(globalThis, '__PREVIEW_RUNTIME_RELOAD__', reloadSpy);

		const socket = bootHmrClient();
		socket.dispatch('message', {
			data: JSON.stringify({
				type: 'full-reload',
				version: 35,
			}),
		});

		vi.advanceTimersByTime(200);

		expect(reloadSpy).toHaveBeenCalledTimes(1);
		expect(globalThis.location.pathname).toBe('/preview');
		expect(globalThis.location.search).toBe('?view=split');
		expect(globalThis.location.hash).toBe('');

		FakeWebSocket.reset();

		const reloadedSocket = bootHmrClient(35);
		reloadedSocket.dispatch('open');

		expect(reloadedSocket.sentMessages).toContain(JSON.stringify({ type: 'hmr-connect', version: 35 }));
	});

	it('updates linked stylesheets using canonical preview ids', async () => {
		bootPreviewRuntime();
		const previewRuntime = getPreviewRuntime();

		const link = document.createElement('link');
		link.setAttribute('rel', 'stylesheet');
		link.setAttribute('href', '/src/style.css');
		link.dataset.previewId = '/src/style.css';
		document.head.append(link);

		await previewRuntime.applyUpdate({
			type: 'update',
			path: '/src/style.css',
			timestamp: 123,
			targets: [{ id: '/src/style.css', kind: 'style-link' }],
		});

		expect(link.getAttribute('href')).toBe('/src/style.css?t=123');
	});

	it('reports whether a normalized module is in the running graph', () => {
		bootPreviewRuntime();
		const previewRuntime = getPreviewRuntime();

		expect(previewRuntime.hasModule('/@vinext-client/%2Fapp%2Fpage.tsx')).toBe(false);
		previewRuntime.registerModule('/@vinext-client/%2Fapp%2Fcounter.tsx?t=1', []);
		expect(previewRuntime.hasModule('/@vinext-client/%2Fapp%2Fcounter.tsx?t=2')).toBe(true);
	});

	it('reruns the nearest accepted boundary for dependency changes', async () => {
		bootPreviewRuntime();
		const previewRuntime = getPreviewRuntime();

		const importModule = vi.fn(async (_moduleId: string, importUrl: string) => ({ importUrl }));
		Reflect.set(globalThis, '__PREVIEW_RUNTIME_IMPORT__', importModule);
		Reflect.set(globalThis, '__RefreshRuntime', { performReactRefresh: vi.fn() });

		previewRuntime.registerModule('/src/util.ts', []);
		previewRuntime.registerModule('/src/app.tsx', ['/src/util.ts']);
		previewRuntime.createHotContext('/src/app.tsx').accept();

		await previewRuntime.applyUpdate({
			type: 'update',
			path: '/src/util.ts',
			timestamp: 456,
			targets: [{ id: '/src/util.ts', kind: 'module' }],
		});

		expect(importModule).toHaveBeenCalledWith('/src/app.tsx', '/src/app.tsx?t=456');
	});

	it('runs dependency acceptance callbacks with the updated module namespace', async () => {
		bootPreviewRuntime();
		const previewRuntime = getPreviewRuntime();

		const importModule = vi.fn(async (moduleId: string) => ({ moduleId, next: true }));
		Reflect.set(globalThis, '__PREVIEW_RUNTIME_IMPORT__', importModule);

		previewRuntime.registerModule('/src/dep.ts', []);
		previewRuntime.registerModule('/src/entry.ts', ['/src/dep.ts']);

		const acceptCallback = vi.fn();
		previewRuntime.createHotContext('/src/entry.ts').accept('./dep.ts', acceptCallback);

		await previewRuntime.applyUpdate({
			type: 'update',
			path: '/src/dep.ts',
			timestamp: 789,
			targets: [{ id: '/src/dep.ts', kind: 'module' }],
		});

		expect(importModule).toHaveBeenCalledWith('/src/dep.ts', '/src/dep.ts?t=789');
		expect(acceptCallback).toHaveBeenCalledWith({ moduleId: '/src/dep.ts', next: true });
	});

	it('reloads when an updated module is not in the running graph', async () => {
		bootPreviewRuntime();
		const previewRuntime = getPreviewRuntime();
		const reloadSpy = vi.fn();
		const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
		Reflect.set(globalThis, '__PREVIEW_RUNTIME_RELOAD__', reloadSpy);

		await previewRuntime.applyUpdate({
			type: 'update',
			path: '/src/new-module.ts',
			timestamp: 101,
			targets: [{ id: '/src/new-module.ts', kind: 'module' }],
		});

		expect(debugSpy).toHaveBeenCalledWith('[preview-hmr] changed module not in running graph; reloading preview', '/src/new-module.ts');
		expect(reloadSpy).toHaveBeenCalledTimes(1);
	});

	it('prunes orphaned modules and removes their injected styles when imports are dropped', async () => {
		bootPreviewRuntime();
		const previewRuntime = getPreviewRuntime();

		previewRuntime.registerModule('/src/style.css', []);
		previewRuntime.upsertStyle('/src/style.css', 'body { color: red; }');
		const prune = vi.fn();
		previewRuntime.createHotContext('/src/style.css').prune(prune);

		// app imports the style module.
		previewRuntime.registerModule('/src/app.tsx', ['/src/style.css']);
		expect(document.querySelector('style[data-preview-id="/src/style.css"]')).not.toBeNull();

		// app stops importing the style module → it becomes orphaned and is pruned.
		previewRuntime.registerModule('/src/app.tsx', []);

		expect(prune).toHaveBeenCalledTimes(1);
		expect(document.querySelector('style[data-preview-id="/src/style.css"]')).toBeNull();
	});

	it('bubbles invalidate() to importers and reruns the nearest accepting boundary', async () => {
		bootPreviewRuntime();
		const previewRuntime = getPreviewRuntime();

		// Re-importing the child re-registers a self-accept callback that
		// immediately invalidates — the runtime must then bubble to the parent.
		const importModule = vi.fn(async (moduleId: string, importUrl: string) => {
			if (moduleId === '/src/child.tsx') {
				previewRuntime.registerModule('/src/child.tsx', []);
				const refreshedChildHot = previewRuntime.createHotContext('/src/child.tsx');
				refreshedChildHot.accept(() => {
					refreshedChildHot.invalidate('cannot handle');
				});
			}
			return { importUrl };
		});
		Reflect.set(globalThis, '__PREVIEW_RUNTIME_IMPORT__', importModule);
		Reflect.set(globalThis, '__RefreshRuntime', { performReactRefresh: vi.fn() });

		previewRuntime.registerModule('/src/child.tsx', []);
		previewRuntime.registerModule('/src/parent.tsx', ['/src/child.tsx']);
		previewRuntime.createHotContext('/src/parent.tsx').accept();

		const childHot = previewRuntime.createHotContext('/src/child.tsx');
		childHot.accept(() => {
			childHot.invalidate('cannot handle');
		});

		await previewRuntime.applyUpdate({
			type: 'update',
			path: '/src/child.tsx',
			timestamp: 555,
			targets: [{ id: '/src/child.tsx', kind: 'module' }],
		});

		// child boundary runs first, then invalidation bubbles to the parent boundary.
		expect(importModule).toHaveBeenCalledWith('/src/child.tsx', '/src/child.tsx?t=555');
		expect(importModule).toHaveBeenCalledWith('/src/parent.tsx', '/src/parent.tsx?t=555');
	});

	it('reloads when invalidate() reaches a root module with no importers', async () => {
		bootPreviewRuntime();
		const previewRuntime = getPreviewRuntime();
		const reloadSpy = vi.fn();
		Reflect.set(globalThis, '__PREVIEW_RUNTIME_RELOAD__', reloadSpy);
		const importModule = vi.fn(async (moduleId: string) => {
			if (moduleId === '/src/entry.tsx') {
				previewRuntime.registerModule('/src/entry.tsx', []);
				const refreshedEntryHot = previewRuntime.createHotContext('/src/entry.tsx');
				refreshedEntryHot.accept(() => {
					refreshedEntryHot.invalidate();
				});
			}
			return {};
		});
		Reflect.set(globalThis, '__PREVIEW_RUNTIME_IMPORT__', importModule);
		Reflect.set(globalThis, '__RefreshRuntime', { performReactRefresh: vi.fn() });

		previewRuntime.registerModule('/src/entry.tsx', []);
		const entryHot = previewRuntime.createHotContext('/src/entry.tsx');
		entryHot.accept(() => {
			entryHot.invalidate();
		});

		await previewRuntime.applyUpdate({
			type: 'update',
			path: '/src/entry.tsx',
			timestamp: 606,
			targets: [{ id: '/src/entry.tsx', kind: 'module' }],
		});

		expect(reloadSpy).toHaveBeenCalledTimes(1);
	});

	it('delivers hot.on listeners for runtime-dispatched events', async () => {
		bootPreviewRuntime();
		const previewRuntime = getPreviewRuntime();

		previewRuntime.registerModule('/src/listener.ts', []);
		const listener = vi.fn();
		previewRuntime.createHotContext('/src/listener.ts').on('custom:event', listener);

		previewRuntime.emitEvent('custom:event', { value: 1 });
		expect(listener).toHaveBeenCalledWith({ value: 1 });
	});

	it('routes server custom messages and hot.send through the transport', async () => {
		bootPreviewRuntime();
		const previewRuntime = getPreviewRuntime();

		const listener = vi.fn();
		previewRuntime.registerModule('/src/custom.ts', []);
		previewRuntime.createHotContext('/src/custom.ts').on('plugin:data', listener);

		const socket = bootHmrClient();
		socket.dispatch('open');

		socket.dispatch('message', {
			data: JSON.stringify({ type: 'custom', event: 'plugin:data', data: { hello: 'world' } }),
		});
		expect(listener).toHaveBeenCalledWith({ hello: 'world' });

		previewRuntime.createHotContext('/src/custom.ts').send('client:event', { ok: true });
		expect(socket.sentMessages).toContain(JSON.stringify({ type: 'custom', event: 'client:event', data: { ok: true } }));
	});
	it('delivers live runtime status to the standalone handover bridge', () => {
		bootPreviewRuntime();
		const socket = bootHmrClient();
		const received: unknown[] = [];
		const receive = (event: Event) => {
			if (event instanceof CustomEvent) received.push(event.detail);
		};
		globalThis.addEventListener('__preview-runtime-status', receive);
		try {
			const status = { preview: { backend: 'container', phase: 'ready', generation: 2 } };
			socket.dispatch('message', { data: JSON.stringify({ type: 'runtime-status', status }) });
			expect(received).toEqual([status]);
		} finally {
			globalThis.removeEventListener('__preview-runtime-status', receive);
		}
	});

	it('preserves an existing self-accept callback when auto-accept runs afterwards', async () => {
		bootPreviewRuntime();
		const previewRuntime = getPreviewRuntime();

		const acceptCallback = vi.fn();
		const importModule = vi.fn(async () => {
			previewRuntime.registerModule('/src/app.tsx', []);
			const hot = previewRuntime.createHotContext('/src/app.tsx');
			hot.accept(acceptCallback);
			hot.accept();
			return { refreshed: true };
		});
		Reflect.set(globalThis, '__PREVIEW_RUNTIME_IMPORT__', importModule);

		previewRuntime.registerModule('/src/app.tsx', []);
		const hot = previewRuntime.createHotContext('/src/app.tsx');
		hot.accept(acceptCallback);
		hot.accept();

		await previewRuntime.applyUpdate({
			type: 'update',
			path: '/src/app.tsx',
			timestamp: 202,
			targets: [{ id: '/src/app.tsx', kind: 'module' }],
		});

		expect(importModule).toHaveBeenCalledWith('/src/app.tsx', '/src/app.tsx?t=202');
		expect(acceptCallback).toHaveBeenCalledWith({ refreshed: true });
	});
});
