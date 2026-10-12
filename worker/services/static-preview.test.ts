import { addMapping, GenMapping, setSourceContent, toEncodedMap } from '@jridgewell/gen-mapping';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildPreviewExternalModuleRequest } from '@shared/preview-path';
import { runWithProjectFs } from '@worker/lib/project-fs';
import { createInMemoryProjectFs } from '@worker/lib/test-workspace';

const mocks = vi.hoisted(() => {
	const forwardedFetch = vi.fn(async (request: Request) => {
		return Response.json({
			method: request.method,
			contentType: request.headers.get('content-type'),
			body: await request.text(),
		});
	});
	const bundleFiles = vi.fn(async () => ({ code: 'export default {};', warnings: [] }));
	const loaderGet = vi.fn((_key: string, callback?: () => Promise<unknown>) => ({
		getEntrypoint: () => ({
			fetch: async (request: Request) => {
				await callback?.();
				return forwardedFetch(request);
			},
		}),
	}));
	const logTailer = vi.fn(() => ({}));
	const objectStorageBinding = vi.fn(() => ({}));
	const readBindingsConfig = vi.fn(async () => ({}));

	return {
		bundleFiles,
		forwardedFetch,
		loaderGet,
		logTailer,
		objectStorageBinding,
		readBindingsConfig,
	};
});

vi.mock('chobitsu?raw-minified', () => ({
	hash: 'test-hash',
	source: 'export default {}',
}));
vi.mock('../lib/preview-scripts/chobitsu-init.js?raw-minified', () => ({
	hash: 'test-hash',
	source: 'export default {}',
}));
vi.mock('../lib/preview-scripts/element-picker.js?raw-minified', () => ({
	hash: 'test-hash',
	source: 'export default {}',
}));
vi.mock('../lib/preview-scripts/error-overlay.js?raw-minified', () => ({
	hash: 'test-hash',
	source: 'export default {}',
}));
vi.mock('../lib/preview-scripts/hmr-client.js?raw-minified', () => ({
	hash: 'test-hash',
	source: 'export default {}',
}));
vi.mock('../lib/preview-scripts/preview-runtime.js?raw-minified', () => ({
	hash: 'test-hash',
	source: 'export default {}',
}));
vi.mock('../lib/preview-scripts/react-refresh-preamble.js?raw-minified', () => ({
	hash: 'test-hash',
	source: 'export default {}',
}));
vi.mock('cloudflare:workers', () => ({
	env: {
		DB: {},
		LOADER: {
			get: mocks.loaderGet,
		},
	},
	exports: {
		LogTailer: mocks.logTailer,
		ObjectStorageBinding: mocks.objectStorageBinding,
	},
	tracing: undefined,
}));
vi.mock('../lib/protected-files', () => ({
	readBindingsConfig: mocks.readBindingsConfig,
}));
vi.mock('./bundle-service', () => ({
	bundleFiles: mocks.bundleFiles,
}));

import { StaticReactPreview } from './static-preview';
import { finalizePreviewResponse } from '../lib/preview-response-headers';

function createResponseWithUrl(body: string, url: string, contentType = 'application/javascript'): Response {
	const response = new Response(body, { headers: { 'Content-Type': contentType } });
	Object.defineProperty(response, 'url', { value: url });
	return response;
}

function createBundleWithInlineSourceMap(sourceMapBase64: string): string {
	return `export default {};\n//# source${'MappingURL'}=data:application/json;base64,${sourceMapBase64}`;
}

function createPreviewRuntimeErrorResponse(message: string, stack: string): Response {
	return Response.json(
		{ message, stack },
		{
			status: 500,
			headers: { 'X-Worker-Ide-Preview-Runtime-Error': '1' },
		},
	);
}

describe('PreviewService external module proxy', () => {
	afterEach(() => {
		mocks.forwardedFetch.mockClear();
		mocks.loaderGet.mockClear();
		mocks.logTailer.mockClear();
		mocks.objectStorageBinding.mockClear();
		mocks.readBindingsConfig.mockClear();
		mocks.bundleFiles.mockClear();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('rejects invalid external module requests before fetching', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		const previewService = new StaticReactPreview('/project', 'project-1');
		const response = await previewService.serveFile(
			new Request('https://preview.local/__preview_external?url=https%3A%2F%2Fexample.com%2Fmodule.mjs'),
			'https://ide.local',
		);

		expect(response.status).toBe(400);
		expect(response.headers.get('X-Robots-Tag')).toBeNull();
		expect(await response.text()).toBe('Invalid external module request');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects external module redirects that leave esm.sh', async () => {
		const fetchMock = vi.fn(async () => createResponseWithUrl('export default 1;', 'https://example.com/module.mjs'));
		vi.stubGlobal('fetch', fetchMock);

		const previewService = new StaticReactPreview('/project', 'project-1');
		const response = await previewService.serveFile(
			new Request(`https://preview.local${buildPreviewExternalModuleRequest('react')}`),
			'https://ide.local',
		);

		expect(response.headers.get('Content-Type')).toBe('application/javascript');
		expect(response.headers.get('X-Robots-Tag')).toBeNull();
		expect(await response.text()).toContain('External module redirect target is not allowed');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('does not retain external modules in Worker memory between preview requests', async () => {
		const fetchMock = vi.fn(async () => createResponseWithUrl('export default 1;', 'https://esm.sh/react?dev'));
		vi.stubGlobal('fetch', fetchMock);

		const previewService = new StaticReactPreview('/project', crypto.randomUUID());
		const request = new Request(`https://preview.local${buildPreviewExternalModuleRequest('react')}`);

		const firstResponse = await previewService.serveFile(request, 'https://ide.local');
		const secondResponse = await previewService.serveFile(request, 'https://ide.local');

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(firstResponse.headers.get('Cache-Control')).toBe('public, max-age=1800');
		expect(secondResponse.headers.get('Cache-Control')).toBe('public, max-age=1800');
		expect(await firstResponse.text()).toBe('export default 1;');
		expect(await secondResponse.text()).toBe('export default 1;');
	});

	it('does not use an in-memory single-flight cache for concurrent external modules', async () => {
		const fetchMock = vi.fn(async () => createResponseWithUrl('export default 1;', 'https://esm.sh/react-dom/client?dev'));
		vi.stubGlobal('fetch', fetchMock);

		const previewService = new StaticReactPreview('/project', crypto.randomUUID());
		const request = new Request(`https://preview.local${buildPreviewExternalModuleRequest('react-dom/client')}`);
		const firstResponsePromise = previewService.serveFile(request, 'https://ide.local');
		const secondResponsePromise = previewService.serveFile(request, 'https://ide.local');

		const [firstResponse, secondResponse] = await Promise.all([firstResponsePromise, secondResponsePromise]);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(await firstResponse.text()).toBe('export default 1;');
		expect(await secondResponse.text()).toBe('export default 1;');
	});

	it('preserves POST method and JSON body when forwarding preview API requests', async () => {
		const previewService = new StaticReactPreview('/project', 'project-1');
		Reflect.set(
			previewService,
			'collectFilesForBundle',
			vi.fn(async () => ({
				'worker/index.ts': 'export default { async fetch(request) { return Response.json({ ok: true }); } };',
			})),
		);
		Reflect.set(
			previewService,
			'loadKnownDependencies',
			vi.fn(async () => new Map()),
		);
		Reflect.set(
			previewService,
			'hashContent',
			vi.fn(async () => 'hash'),
		);

		const response = await previewService.handlePreviewAPI(
			new Request('https://preview.local/api/store', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', cookie: 'session=secret' },
				body: JSON.stringify({ key: 'greeting', value: 'hello' }),
			}),
			'/api/store',
		);

		expect(mocks.loaderGet).toHaveBeenCalledOnce();
		expect(mocks.forwardedFetch).toHaveBeenCalledOnce();
		expect(response.headers.get('X-Robots-Tag')).toBeNull();
		expect(await response.json()).toEqual({
			method: 'POST',
			contentType: 'application/json',
			body: JSON.stringify({ key: 'greeting', value: 'hello' }),
		});
	});

	it('maps preview API runtime stack locations through inline source maps', async () => {
		const sourceMap = new GenMapping({ file: 'worker.js' });
		setSourceContent(sourceMap, 'worker/index.ts', 'export default { async fetch() { return Response.json({ value: asdasdasqs1 }); } };');
		addMapping(sourceMap, {
			generated: { line: 1, column: 64 },
			source: 'worker/index.ts',
			original: { line: 1, column: 64 },
		});
		const sourceMapBase64 = btoa(JSON.stringify(toEncodedMap(sourceMap)));
		mocks.forwardedFetch.mockResolvedValueOnce(
			createPreviewRuntimeErrorResponse(
				'asdasdasqs1 is not defined',
				'ReferenceError: asdasdasqs1 is not defined\n    at fetch (user-worker.js:1:65)',
			),
		);
		const previewService = new StaticReactPreview('/project', 'project-1');
		Reflect.set(
			previewService,
			'collectFilesForBundle',
			vi.fn(async () => ({
				'worker/index.ts': [
					'export default {',
					'\tasync fetch() {',
					'\t\treturn Response.json({ value: asdasdasqs1 });',
					'\t},',
					'};',
				].join('\n'),
			})),
		);
		Reflect.set(
			previewService,
			'loadKnownDependencies',
			vi.fn(async () => new Map()),
		);
		Reflect.set(
			previewService,
			'hashContent',
			vi.fn(async () => 'hash'),
		);
		mocks.bundleFiles.mockResolvedValueOnce({
			code: createBundleWithInlineSourceMap(sourceMapBase64),
			warnings: [],
		});

		const response = await previewService.handlePreviewAPI(new Request('https://preview.local/api/inspect'), '/api/inspect');
		const body = await response.json();

		const loaderCallback = mocks.loaderGet.mock.calls[0]?.[1];
		expect(mocks.loaderGet.mock.calls[0]?.[0]).toBe('worker:preview-api-v2:hash');
		expect(loaderCallback).toBeDefined();
		const workerCode = await loaderCallback?.();
		expect(workerCode).toEqual(
			expect.objectContaining({
				mainModule: 'worker.js',
				modules: expect.objectContaining({
					'worker.js': expect.stringContaining("await import('./user-worker.js')"),
				}),
			}),
		);

		expect(response.status).toBe(500);
		expect(body).toEqual({
			error: 'asdasdasqs1 is not defined',
			serverError: expect.objectContaining({
				type: 'runtime',
				message: 'asdasdasqs1 is not defined',
				location: { file: 'worker/index.ts', line: 1, column: 65 },
			}),
		});
	});

	it('loads asset settings from wrangler.jsonc with trailing commas', async () => {
		const { workspace, adapter } = createInMemoryProjectFs();
		await workspace.writeFile(
			'/project/wrangler.jsonc',
			`{
			"assets": {
				"not_found_handling": "single-page-application",
				"run_worker_first": ["/api/*"],
			},
		}`,
		);

		const previewService = new StaticReactPreview('/project', 'project-1');
		const assetSettings = await runWithProjectFs(adapter, () => previewService.loadAssetSettings());

		expect(assetSettings).toEqual({
			not_found_handling: 'single-page-application',
			html_handling: 'auto-trailing-slash',
			run_worker_first: ['/api/*'],
		});
	});

	it('falls through to the worker on asset miss when not_found_handling is none', async () => {
		const previewService = new StaticReactPreview('/project', 'project-1');
		const serveFile = vi.fn(async () => new Response('Not Found', { status: 404 }));
		const handlePreviewAPI = vi.fn(async () => new Response('worker response'));
		const hasWorkerEntrypoint = vi.fn(async () => true);
		Reflect.set(previewService, 'serveFile', serveFile);
		Reflect.set(previewService, 'handlePreviewAPI', handlePreviewAPI);
		Reflect.set(previewService, 'hasWorkerEntrypoint', hasWorkerEntrypoint);

		const response = await previewService.routePreviewRequest(new Request('https://preview.local/api/store'), 'https://ide.local', {
			run_worker_first: false,
			not_found_handling: 'none',
			html_handling: 'auto-trailing-slash',
		});

		expect(serveFile).toHaveBeenCalledOnce();
		expect(hasWorkerEntrypoint).toHaveBeenCalledOnce();
		expect(handlePreviewAPI).toHaveBeenCalledWith(expect.any(Request), '/api/store');
		expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
		expect(await response.text()).toBe('worker response');
	});

	it('does not fall through to the worker when not_found_handling is configured', async () => {
		const previewService = new StaticReactPreview('/project', 'project-1');
		const assetResponse = new Response('custom 404', { status: 404 });
		const serveFile = vi.fn(async () => assetResponse);
		const handlePreviewAPI = vi.fn(async () => new Response('worker response'));
		const hasWorkerEntrypoint = vi.fn(async () => true);
		Reflect.set(previewService, 'serveFile', serveFile);
		Reflect.set(previewService, 'handlePreviewAPI', handlePreviewAPI);
		Reflect.set(previewService, 'hasWorkerEntrypoint', hasWorkerEntrypoint);

		const response = await previewService.routePreviewRequest(new Request('https://preview.local/missing'), 'https://ide.local', {
			run_worker_first: false,
			not_found_handling: '404-page',
			html_handling: 'auto-trailing-slash',
		});

		expect(serveFile).toHaveBeenCalledOnce();
		expect(hasWorkerEntrypoint).not.toHaveBeenCalled();
		expect(handlePreviewAPI).not.toHaveBeenCalled();
		expect(response).not.toBe(assetResponse);
		expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
		expect(await response.text()).toBe('custom 404');
	});

	it('adds no-index headers to preview worker-first responses', async () => {
		const previewService = new StaticReactPreview('/project', 'project-1');
		const serveFile = vi.fn(async () => new Response('asset response'));
		const handlePreviewAPI = vi.fn(async () => new Response('worker response'));
		Reflect.set(previewService, 'serveFile', serveFile);
		Reflect.set(previewService, 'handlePreviewAPI', handlePreviewAPI);

		const response = await previewService.routePreviewRequest(new Request('https://preview.local/api/store'), 'https://ide.local', {
			run_worker_first: true,
			not_found_handling: 'none',
			html_handling: 'auto-trailing-slash',
		});

		expect(serveFile).not.toHaveBeenCalled();
		expect(handlePreviewAPI).toHaveBeenCalledWith(expect.any(Request), '/api/store');
		expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
		expect(await response.text()).toBe('worker response');
	});

	it('strips generated Set-Cookie headers at the preview boundary', async () => {
		const previewService = new StaticReactPreview('/project', 'project-1');
		const headers = new Headers();
		headers.append('Set-Cookie', 'preview_access=one; Path=/; HttpOnly');
		headers.append('Set-Cookie', 'preview_metadata=two; Path=/; HttpOnly');
		const handlePreviewAPI = vi.fn(async () => new Response('worker response', { headers }));
		Reflect.set(previewService, 'handlePreviewAPI', handlePreviewAPI);

		const response = await previewService.routePreviewRequest(new Request('https://preview.local/api/store'), 'https://ide.local', {
			run_worker_first: true,
			not_found_handling: 'none',
			html_handling: 'auto-trailing-slash',
		});

		expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
		expect(response.headers.getSetCookie()).toEqual([]);
		expect(await response.text()).toBe('worker response');
	});

	it('does not rewrap WebSocket upgrade responses when adding no-index headers', () => {
		const response = new Response(undefined, { headers: { Upgrade: 'websocket' } });
		Object.defineProperty(response, 'status', { value: 101 });

		const nextResponse = finalizePreviewResponse(response, { ideOrigin: 'https://codemaxxing.app' });

		expect(nextResponse).toBe(response);
		expect(nextResponse.headers.get('X-Robots-Tag')).toBeNull();
	});
});
