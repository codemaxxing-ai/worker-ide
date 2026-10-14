/** Stateless vinext preview adapter backed by the cacheable BuildArtifact entrypoint. */
import { env, exports } from 'cloudflare:workers';

import { SNAPSHOT_EXCLUDED_DIRECTORIES, STORAGE_BINDING_NAME, WORKERS_COMPATIBILITY_DATE } from '@shared/constants';
import { isPreviewStylePath, normalizePreviewPath } from '@shared/preview-path';

import { DEVELOPMENT_STYLE_PREFIX } from './shared';
import { toBundleServerError } from '../../../lib/build-server-error';
import { coordinatorNamespace, filesystemNamespace } from '../../../lib/durable-object-namespaces';
import { stripPreviewRequestCredentials } from '../../../lib/preview-request-headers';
import { toDurableObjectId } from '../../../lib/project-id';
import { readBindingsConfig } from '../../../lib/protected-files';
import { resolveStorageQuotaForProject } from '../../../lib/storage-quota';
import { withSpan } from '../../../lib/tracing';
import { getBuildArtifact } from '../build-artifact-client';
import { DEPENDENCY_PREFIX, DEPENDENCY_VERSION_PARAM, isDevelopmentModuleRequest } from '../runtime/development-module-server';
import { getServerEntrypoint, serverModulesFromOutput } from '../runtime/loader-runner';

import type { ArtifactFrameworkRuntime, RuntimeBuild } from './types';
import type { ServerError } from '@shared/types';

const HMR_SCRIPT_PATHS = [
	'/__vinext_react_refresh.js',
	'/__vinext_error_overlay.js',
	'/__vinext_preview_runtime.js',
	'/__vinext_hmr_client.js',
	'/__vinext_chobitsu.js',
	'/__vinext_chobitsu_init.js',
	'/__vinext_element_picker.js',
];
const HMR_GLUE_PATH = '/__vinext_hmr_glue.js';

export interface VinextPreviewInput {
	request: Request;
	projectId: string;
	projectRoot: string;
	ideOrigin: string;
	snapshotHash: string;
	runtime: ArtifactFrameworkRuntime;
}

export async function serveVinextPreview(input: VinextPreviewInput): Promise<Response> {
	const url = new URL(input.request.url);
	try {
		await coordinatorNamespace.getByName(`project:${input.projectId}`).markVinextPreview();
	} catch {
		// Preview rendering does not depend on a coordinator connection. HMR simply
		// falls back to the generic update path until it becomes available.
	}
	if (HMR_SCRIPT_PATHS.includes(url.pathname)) return serveHmrScript(url.pathname);
	if (url.pathname === HMR_GLUE_PATH) return scriptResponse(input.runtime.hmrGlue(), 'static');
	if (url.pathname.startsWith(DEVELOPMENT_STYLE_PREFIX)) {
		const style = await serveDevelopmentStyle(input, url.pathname);
		if (style !== undefined) return style;
	}
	try {
		if (isDevelopmentModuleRequest(url.pathname)) {
			const code = await serveDevelopmentModule(input, url);
			if (code !== undefined) {
				const immutable = url.pathname.startsWith(DEPENDENCY_PREFIX) && url.searchParams.has(DEPENDENCY_VERSION_PARAM);
				return scriptResponse(code, immutable ? 'immutable' : 'no-cache');
			}
		}
		// Capture the version before building so edits during rendering are still
		// detected when the preview connects. A fixed zero causes a reload loop.
		const bootVersion = await coordinatorNamespace.getByName(`project:${input.projectId}`).getUpdateVersion();
		const build = await getBuildArtifact({
			projectId: input.projectId,
			projectRoot: input.projectRoot,
			runtimeId: input.runtime.id,
			mode: 'preview',
			snapshotHash: input.snapshotHash,
		});
		const environment = await resolveServerEnvironment(input);
		const safeRequest = new Request(input.request);
		stripPreviewRequestCredentials(safeRequest.headers);
		const response = await input.runtime.route(safeRequest, {
			clientOutput: build.clientOutput,
			projectRoot: input.projectRoot,
			buildId: `${input.projectId}:${input.snapshotHash}`,
			getServer: createServerFactory(input, build, environment),
		});
		if (response.status >= 500) {
			const surfaced = await surfaceServerRenderError(response, input);
			if (surfaced !== undefined) return surfaced;
		}
		return response.headers.get('Content-Type')?.includes('text/html') ? injectHmrRuntime(response, input, bootVersion) : response;
	} catch (error) {
		return renderServerError(toBundleServerError(error), input);
	}
}

async function serveDevelopmentStyle(input: VinextPreviewInput, pathname: string): Promise<Response | undefined> {
	let sourcePath: string;
	try {
		sourcePath = normalizePreviewPath(decodeURIComponent(pathname.slice(DEVELOPMENT_STYLE_PREFIX.length)));
	} catch {
		return undefined;
	}
	if (!isPreviewStylePath(sourcePath) || sourcePath.includes('/..')) return undefined;
	const filesystem = filesystemNamespace.get(toDurableObjectId(filesystemNamespace, input.projectId));
	const source = await filesystem.wsReadFile(sourcePath);
	if (source === null) return undefined;
	return new Response(source, { headers: { 'Content-Type': 'text/css', 'Cache-Control': 'no-cache' } });
}

async function serveDevelopmentModule(input: VinextPreviewInput, url: URL): Promise<string | undefined> {
	const filesystem = filesystemNamespace.get(toDurableObjectId(filesystemNamespace, input.projectId));
	const snapshot = await filesystem.collectProjectSnapshot(SNAPSHOT_EXCLUDED_DIRECTORIES);
	return withSpan('vinext.devModule', () => env.VITE_HOST.serveDevelopmentModule(url.pathname, snapshot));
}

function createServerFactory(
	input: VinextPreviewInput,
	build: RuntimeBuild,
	environment: Record<string, unknown>,
): () => ReturnType<typeof getServerEntrypoint> {
	let server: ReturnType<typeof getServerEntrypoint> | undefined;
	return () => {
		server ??= getServerEntrypoint({
			loader: env.LOADER,
			cacheKey: `${input.runtime.id}:${input.projectId}:${input.snapshotHash}`,
			moduleSet: {
				compatibilityDate: WORKERS_COMPATIBILITY_DATE,
				compatibilityFlags: [...input.runtime.serverCompatibilityFlags],
				mainModule: build.mainModule,
				modules: serverModulesFromOutput(build.serverModules),
				...(Object.keys(environment).length > 0 ? { env: environment } : {}),
			},
		});
		return server;
	};
}

async function resolveServerEnvironment(input: VinextPreviewInput): Promise<Record<string, unknown>> {
	const bindingsConfig = await readBindingsConfig(input.projectRoot);
	if (!bindingsConfig.storage) return {};
	const quotaBytes = await resolveStorageQuotaForProject(input.projectId, env.DB);
	return { [STORAGE_BINDING_NAME]: exports.ObjectStorageBinding({ props: { projectId: input.projectId, quotaBytes } }) };
}

async function injectHmrRuntime(response: Response, input: VinextPreviewInput, bootVersion: number): Promise<Response> {
	const html = await response.text();
	const url = new URL(input.request.url);
	const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	const config = { wsUrl: `${protocol}//${url.host}/__ws`, ideOrigin: input.ideOrigin, projectId: input.projectId, bootVersion };
	const scripts = [
		`<script>window.__PREVIEW_CONFIG=${JSON.stringify(config).replaceAll('<', String.raw`\u003c`)}</script>`,
		...HMR_SCRIPT_PATHS.map((path) => `<script src="${path}"></script>`),
		`<script src="${HMR_GLUE_PATH}"></script>`,
	].join('');
	return new Response(html.includes('<head>') ? html.replace('<head>', `<head>${scripts}`) : scripts + html, {
		status: response.status,
		headers: response.headers,
	});
}

async function surfaceServerRenderError(response: Response, input: VinextPreviewInput): Promise<Response | undefined> {
	const body = await response.clone().text();
	if (!body.includes('id="__next_error__"')) return undefined;
	return renderServerError(
		{
			id: crypto.randomUUID(),
			timestamp: Date.now(),
			type: 'runtime',
			message: 'The server failed while rendering this route (HTTP 500).',
		},
		input,
	);
}

async function renderServerError(error: ServerError, input: VinextPreviewInput): Promise<Response> {
	void coordinatorNamespace
		.getByName(`project:${input.projectId}`)
		.sendMessage({ type: 'server-error', error })
		.catch(() => {});
	const payload = JSON.stringify(error)
		.replaceAll('<', String.raw`\u003c`)
		.replaceAll('>', String.raw`\u003e`);
	if (input.request.headers.get('Accept')?.includes('text/html')) {
		return new Response(
			`<!doctype html><script src="/__vinext_error_overlay.js"></script><script>window.showErrorOverlay(${payload})</script>`,
			{
				headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' },
			},
		);
	}
	return scriptResponse(`if(typeof showErrorOverlay==='function'){showErrorOverlay(${payload})}else{console.error(${payload}.message)}`);
}

function serveHmrScript(path: string): Promise<Response> {
	return importHmrScripts().then((scripts) => scriptResponse(scripts[path], 'static'));
}

async function importHmrScripts(): Promise<Record<string, string>> {
	const [refresh, overlay, runtime, hmrClient, chobitsu, chobitsuInit, elementPicker] = await Promise.all([
		import('@worker/lib/preview-scripts/react-refresh-preamble.js?raw-minified'),
		import('@worker/lib/preview-scripts/error-overlay.js?raw-minified'),
		import('@worker/lib/preview-scripts/preview-runtime.js?raw-minified'),
		import('@worker/lib/preview-scripts/hmr-client.js?raw-minified'),
		import('chobitsu?raw-minified'),
		import('@worker/lib/preview-scripts/chobitsu-init.js?raw-minified'),
		import('@worker/lib/preview-scripts/element-picker.js?raw-minified'),
	]);
	return {
		'/__vinext_react_refresh.js': refresh.source,
		'/__vinext_error_overlay.js': overlay.source,
		'/__vinext_preview_runtime.js': runtime.source,
		'/__vinext_hmr_client.js': hmrClient.source,
		'/__vinext_chobitsu.js': chobitsu.source,
		'/__vinext_chobitsu_init.js': chobitsuInit.source,
		'/__vinext_element_picker.js': elementPicker.source,
	};
}

function scriptResponse(code: string, cache: 'no-cache' | 'static' | 'immutable' = 'no-cache'): Response {
	const cacheControl =
		cache === 'immutable' ? 'public, max-age=31536000, immutable' : cache === 'static' ? 'public, max-age=3600' : 'no-cache';
	return new Response(code, { headers: { 'Content-Type': 'application/javascript', 'Cache-Control': cacheControl } });
}
