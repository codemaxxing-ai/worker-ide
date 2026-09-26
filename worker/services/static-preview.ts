/**
 * Static React (SPA) + worker preview implementation — the per-request esbuild
 * transform pipeline that serves a project's HTML/source files with HMR and runs
 * its `worker/` entry in a `LOADER` isolate for API routes. This is the
 * implementation behind the `react-spa` framework runtime (see
 * `vite-host/runtimes/react-spa.ts`); the runtime registry selects it for any
 * project a build-host runtime (e.g. vinext) does not claim.
 */
import { source as chobitsuSource, hash as chobitsuHash } from 'chobitsu?raw-minified';
import { env, exports } from 'cloudflare:workers';

import { HIDDEN_ENTRIES, STORAGE_BINDING_NAME, WORKERS_COMPATIBILITY_DATE } from '@shared/constants';
import { parseJsonc } from '@shared/jsonc';
import { parsePreviewExternalModuleRequest, parsePreviewRequest, PREVIEW_EXTERNAL_MODULE_PATH } from '@shared/preview-path';
import { resolveAssetSettings } from '@shared/types';
import { fs } from '@worker/lib/project-fs';

import { bundleFiles } from './bundle-service';
import { BundleDependencyError } from './bundler-client';
import { parseDependencyErrorsFromMessage } from './dependency-error-parser';
import { processHTML, toEsbuildTsconfigRaw, transformModule, type FileSystem } from './transform-service';
import { coordinatorNamespace } from '../lib/durable-object-namespaces';
import { stripPreviewRequestCredentials } from '../lib/preview-request-headers';
import {
	applyAssetSecurityHeaders,
	applyPreviewResponseMiddlewares,
	applyPreviewRobotsHeader,
	PREVIEW_ROBOTS_HEADER_VALUE,
	previewResponseMiddlewares,
} from '../lib/preview-response-headers';
import { source as chobitsuInitSource, hash as chobitsuInitHash } from '../lib/preview-scripts/chobitsu-init.js?raw-minified';
import { source as elementPickerSource, hash as elementPickerHash } from '../lib/preview-scripts/element-picker.js?raw-minified';
import { source as errorOverlaySource, hash as errorOverlayHash } from '../lib/preview-scripts/error-overlay.js?raw-minified';
import { source as hmrClientSource, hash as hmrClientHash } from '../lib/preview-scripts/hmr-client.js?raw-minified';
import { source as previewRuntimeSource, hash as previewRuntimeHash } from '../lib/preview-scripts/preview-runtime.js?raw-minified';
import {
	source as reactRefreshPreambleSource,
	hash as reactRefreshPreambleHash,
} from '../lib/preview-scripts/react-refresh-preamble.js?raw-minified';
import { readBindingsConfig } from '../lib/protected-files';
import { resolveStorageQuotaForProject } from '../lib/storage-quota';
import { withSpan } from '../lib/tracing';
import { serveExternalModule } from './static-preview/external-modules';
import { cleanBuildErrorMessage, resolveOriginalLocationFromStack } from './static-preview/preview-errors';

import type { ResolvedAssetSettings, ServerError } from '@shared/types';
import type { ServerMessage } from '@shared/ws-messages';
const PREVIEW_API_WORKER_VERSION = 'preview-api-v2';
const PREVIEW_API_WRAPPER_MODULE = 'worker.js';
const PREVIEW_API_USER_MODULE = 'user-worker.js';
const PREVIEW_RUNTIME_ERROR_HEADER = 'X-Worker-Ide-Preview-Runtime-Error';

/**
 * Build the CSP header for preview HTML responses.
 *
 * The preview runs on a separate origin from the IDE, so `frame-ancestors`
 * is set to the IDE origin to prevent embedding by arbitrary sites.
 */
function buildPreviewCsp(ideOrigin: string): string {
	return [
		"script-src 'self' 'unsafe-inline' 'unsafe-eval'",
		"style-src 'self' 'unsafe-inline'",
		'img-src * data: blob:',
		'media-src * data: blob:',
		'font-src * data:',
		"connect-src 'self' ws: wss:",
		"frame-src 'none'",
		`frame-ancestors ${ideOrigin}`,
		"object-src 'none'",
		"form-action 'self'",
		"base-uri 'self'",
	].join('; ');
}

function createPreviewApiWrapperModule(): string {
	return `export default {
	async fetch(request, env, ctx) {
		try {
			const { default: worker } = await import('./${PREVIEW_API_USER_MODULE}');
			if (!worker || typeof worker.fetch !== 'function') {
				throw new TypeError('Worker default export must include a fetch handler.');
			}
			return await worker.fetch(request, env, ctx);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const stack = error instanceof Error ? error.stack : undefined;
			return Response.json(
				{ message, stack },
				{ status: 500, headers: { '${PREVIEW_RUNTIME_ERROR_HEADER}': '1' } },
			);
		}
	},
};`;
}

const scriptIntegrityHashes: Record<string, string> = {
	'__chobitsu.js': chobitsuHash,
	'__chobitsu-init.js': chobitsuInitHash,
	'__element-picker.js': elementPickerHash,
	'__error-overlay.js': errorOverlayHash,
	'__hmr-client.js': hmrClientHash,
	'__preview-runtime.js': previewRuntimeHash,
	'__react-refresh-preamble.js': reactRefreshPreambleHash,
};

const INTERNAL_SCRIPTS: Record<string, string> = {
	'/__chobitsu.js': chobitsuSource,
	'/__chobitsu-init.js': chobitsuInitSource,
	'/__element-picker.js': elementPickerSource,
	'/__error-overlay.js': errorOverlaySource,
	'/__hmr-client.js': hmrClientSource,
	'/__preview-runtime.js': previewRuntimeSource,
	'/__react-refresh-preamble.js': reactRefreshPreambleSource,
};

export class StaticReactPreview {
	constructor(
		private projectRoot: string,
		private projectId: string,
	) {}

	withPreviewRobotsHeader(response: Response): Response {
		return applyPreviewResponseMiddlewares(response, { ideOrigin: '' }, [applyPreviewRobotsHeader]);
	}
	withAssetSecurityHeaders(response: Response, ideOrigin: string): Response {
		return applyPreviewResponseMiddlewares(response, { ideOrigin }, [applyAssetSecurityHeaders]);
	}
	finalizePreviewResponse(response: Response, ideOrigin: string): Response {
		return applyPreviewResponseMiddlewares(response, { ideOrigin }, previewResponseMiddlewares);
	}
	async loadAssetSettings(): Promise<ResolvedAssetSettings> {
		try {
			const raw = await fs.readFile(`${this.projectRoot}/wrangler.jsonc`, 'utf8');
			const wrangler: { assets?: Record<string, unknown> } = parseJsonc(raw);
			return resolveAssetSettings(wrangler.assets);
		} catch {
			return resolveAssetSettings();
		}
	}
	matchesRunWorkerFirst(pathname: string, runWorkerFirst: boolean | string[]): boolean {
		if (runWorkerFirst === false) return false;
		if (runWorkerFirst === true) return true;

		const positivePatterns = runWorkerFirst.filter((p) => !p.startsWith('!'));
		const negativePatterns = runWorkerFirst.filter((p) => p.startsWith('!')).map((p) => p.slice(1));

		for (const pattern of negativePatterns) {
			if (this.matchRoutePattern(pathname, pattern)) return false;
		}
		for (const pattern of positivePatterns) {
			if (this.matchRoutePattern(pathname, pattern)) return true;
		}
		return false;
	}
	routePreviewRequest(request: Request, ideOrigin: string, preloadedAssetSettings?: ResolvedAssetSettings): Promise<Response> {
		return withSpan('static.serve', () => this.routePreviewRequestTraced(request, ideOrigin, preloadedAssetSettings), {
			'project.id': this.projectId,
			'request.path': new URL(request.url).pathname,
		});
	}

	private async routePreviewRequestTraced(
		request: Request,
		ideOrigin: string,
		preloadedAssetSettings?: ResolvedAssetSettings,
	): Promise<Response> {
		const assetSettings = preloadedAssetSettings ?? (await this.loadAssetSettings());
		const url = new URL(request.url);

		if (this.matchesRunWorkerFirst(url.pathname, assetSettings.run_worker_first)) {
			return this.finalizePreviewResponse(await this.handlePreviewAPI(request, url.pathname), ideOrigin);
		}

		const assetResponse = await withSpan('static.serveFile', () => this.serveFile(request, ideOrigin, assetSettings));
		if (assetResponse.status !== 404 || assetSettings.not_found_handling !== 'none') {
			return this.finalizePreviewResponse(assetResponse, ideOrigin);
		}

		if (!(await this.hasWorkerEntrypoint())) {
			return this.finalizePreviewResponse(assetResponse, ideOrigin);
		}

		return this.finalizePreviewResponse(await this.handlePreviewAPI(request, url.pathname), ideOrigin);
	}
	async hasWorkerEntrypoint(): Promise<boolean> {
		const workerEntrypoints = ['worker/index.ts', 'worker/index.js'];
		const checks = await Promise.allSettled(workerEntrypoints.map((entryFile) => fs.access(`${this.projectRoot}/${entryFile}`)));

		return checks.some((result) => result.status === 'fulfilled');
	}

	/**
	 * Serve a file from the project for preview.
	 *
	 * @param request - The incoming request (URL path maps directly to project files)
	 * @param ideOrigin - The IDE app's origin for CSP and postMessage targeting
	 * @param preloadedAssetSettings - Pre-loaded asset settings to avoid duplicate reads
	 */
	async serveFile(request: Request, ideOrigin: string, preloadedAssetSettings?: ResolvedAssetSettings): Promise<Response> {
		const url = new URL(request.url);
		const previewRequest = parsePreviewRequest(url.pathname + url.search);
		let filePath = previewRequest.path === '/' ? '/index.html' : previewRequest.path;

		// Serve internal preview scripts
		const internalScript = INTERNAL_SCRIPTS[filePath];
		if (internalScript !== undefined) {
			return new Response(internalScript, {
				headers: {
					'Content-Type': 'application/javascript',
					'Cache-Control': 'public, max-age=31536000, immutable',
				},
			});
		}
		if (filePath === '/chobitsu.js.map') {
			return new Response(undefined, { status: 204 });
		}

		const externalModuleRequest = parsePreviewExternalModuleRequest(url.pathname + url.search);
		if (externalModuleRequest !== undefined) {
			return serveExternalModule(externalModuleRequest.externalUrl, externalModuleRequest.timestamp);
		}
		if (filePath === PREVIEW_EXTERNAL_MODULE_PATH) {
			return new Response('Invalid external module request', {
				status: 400,
				headers: { 'Cache-Control': 'no-cache' },
			});
		}

		const assetSettings = preloadedAssetSettings ?? (await this.loadAssetSettings());

		const htmlHandlingRedirect = await this.handleHtmlRedirects(url, filePath, assetSettings.html_handling);
		if (htmlHandlingRedirect) {
			return htmlHandlingRedirect;
		}

		const viteFs: FileSystem = {
			readFile: (path: string) => fs.readFile(path),
			access: (path: string) => fs.access(path),
		};
		const knownDependencies = await this.loadKnownDependencies();

		// Track whether the entry file was successfully resolved.
		// ENOENT errors during file resolution → true 404.
		// ENOENT errors after resolution (e.g. bundler can't find an import) → error overlay.
		let entryFileResolved = false;

		try {
			let fullPath = `${this.projectRoot}${filePath}`;
			const initialExtension = this.getExtension(filePath);

			if (!initialExtension) {
				const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mts'];
				let resolved = false;

				const directResults = await Promise.allSettled(
					extensions.map((tryExtension) => fs.access(fullPath + tryExtension).then(() => tryExtension)),
				);
				for (const result of directResults) {
					if (result.status === 'fulfilled') {
						fullPath = fullPath + result.value;
						filePath = filePath + result.value;
						resolved = true;
						break;
					}
				}

				if (!resolved) {
					const indexResults = await Promise.allSettled(
						extensions.map((tryExtension) => fs.access(fullPath + '/index' + tryExtension).then(() => tryExtension)),
					);
					for (const result of indexResults) {
						if (result.status === 'fulfilled') {
							fullPath = fullPath + '/index' + result.value;
							filePath = filePath + '/index' + result.value;
							resolved = true;
							break;
						}
					}
				}

				if (!resolved) {
					throw new Error(`ENOENT: no such file or directory, '${filePath}'`);
				}
			}

			const content = await fs.readFile(fullPath);
			entryFileResolved = true;
			const textContent = typeof content === 'string' ? content : new TextDecoder().decode(content);
			const extension = this.getExtension(filePath);

			if (extension === '.html' && previewRequest.mode === 'source') {
				return this.serveHtmlFile(textContent, filePath, url, ideOrigin, viteFs);
			}

			if (previewRequest.mode === 'source' && !['.ts', '.tsx', '.jsx', '.js', '.mjs', '.mts'].includes(extension)) {
				return new Response(content, {
					headers: { 'Content-Type': this.getContentType(extension), 'Cache-Control': 'no-cache' },
				});
			}

			const transformed = await transformModule(filePath, textContent, {
				fs: viteFs,
				projectRoot: this.projectRoot,
				projectId: this.projectId,
				knownDependencies,
				requestTimestamp: previewRequest.timestamp,
			});

			return new Response(transformed.code, {
				headers: { 'Content-Type': transformed.contentType, 'Cache-Control': 'no-cache' },
			});
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			if (errorMessage.includes('ENOENT') && !entryFileResolved) {
				const fallbackResponse = await this.handleNotFoundFallback(url, ideOrigin, assetSettings.not_found_handling);
				if (fallbackResponse) {
					return fallbackResponse;
				}

				// File genuinely not found and no SPA/404 fallback handled it.
				// Return a plain 404 instead of the JS error overlay.
				return new Response('Not Found', {
					status: 404,
					headers: { 'Cache-Control': 'no-cache' },
				});
			}

			console.error('serveFile error:', error);
			const locMatch = errorMessage.match(/([^\s:]+):(\d+):(\d+):\s*ERROR:\s*(.*)/);
			const serverError: ServerError = {
				id: crypto.randomUUID(),
				timestamp: Date.now(),
				type: 'bundle',
				message: cleanBuildErrorMessage(locMatch ? locMatch[4] : errorMessage),
				location: locMatch
					? {
							file: locMatch[1],
							line: Number(locMatch[2]),
							column: Number(locMatch[3]),
						}
					: undefined,
				dependencyErrors:
					(error instanceof BundleDependencyError ? error.dependencyErrors : undefined) ?? parseDependencyErrorsFromMessage(errorMessage),
			};
			await this.broadcastError(serverError).catch(() => {});
			const errorJson = JSON.stringify(serverError)
				.replaceAll('<', String.raw`\u003c`)
				.replaceAll('>', String.raw`\u003e`);
			const errorModule = `if(typeof showErrorOverlay==='function'){showErrorOverlay(${errorJson})}else{console.error(${errorJson}.message)}`;
			return new Response(errorModule, {
				headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' },
			});
		}
	}
	async handlePreviewAPI(request: Request, apiPath: string): Promise<Response> {
		try {
			const files = await this.collectFilesForBundle(`${this.projectRoot}/worker`, 'worker');

			const workerEntry = Object.keys(files).find((f) => f === 'worker/index.ts' || f === 'worker/index.js');

			if (!workerEntry) {
				const error: ServerError = {
					id: crypto.randomUUID(),
					timestamp: Date.now(),
					type: 'bundle',
					message: 'No worker/index.ts found. Create a worker/index.ts file with a default export { fetch }.',
				};
				await this.broadcastError(error).catch(() => {});
				return Response.json({ error: error.message, serverError: error }, { status: 500 });
			}

			const workerFiles = Object.entries(files).toSorted(([a], [b]) => a.localeCompare(b));
			const knownDependencies = await this.loadKnownDependencies();

			const logTailer = exports.LogTailer({ props: { projectId: this.projectId } });

			// Build custom env bindings for the dynamic worker
			const bindingsConfig = await readBindingsConfig(this.projectRoot);
			const workerEnvironment: Record<string, unknown> = {};
			if (bindingsConfig.storage) {
				const quotaBytes = await resolveStorageQuotaForProject(this.projectId, env.DB);
				workerEnvironment[STORAGE_BINDING_NAME] = exports.ObjectStorageBinding({ props: { projectId: this.projectId, quotaBytes } });
			}
			const hasCustomBindings = Object.keys(workerEnvironment).length > 0;

			const tsconfigRaw = await this.loadTsconfigRaw();
			const contentHash = await this.hashContent(
				JSON.stringify(workerFiles) +
					JSON.stringify([...knownDependencies.entries()]) +
					JSON.stringify(bindingsConfig) +
					(tsconfigRaw ?? ''),
			);
			const bundled = await withSpan('static.bundleWorker', () =>
				bundleFiles({
					files,
					entryPoint: workerEntry,
					platform: 'neutral',
					sourcemap: true,
					tsconfigRaw,
					knownDependencies,
				}),
			);

			const worker = env.LOADER.get(`worker:${PREVIEW_API_WORKER_VERSION}:${contentHash}`, () => {
				return {
					compatibilityDate: WORKERS_COMPATIBILITY_DATE,
					mainModule: PREVIEW_API_WRAPPER_MODULE,
					modules: {
						[PREVIEW_API_WRAPPER_MODULE]: createPreviewApiWrapperModule(),
						[PREVIEW_API_USER_MODULE]: bundled.code,
					},
					tails: [logTailer],
					...(hasCustomBindings ? { env: workerEnvironment } : {}),
				};
			});

			const apiUrl = new URL(request.url);
			apiUrl.pathname = apiPath;
			const apiRequest = new Request(apiUrl.toString(), request);
			stripPreviewRequestCredentials(apiRequest.headers);

			const entrypoint = worker.getEntrypoint();
			const response = await entrypoint.fetch(apiRequest);
			if (response.headers.get(PREVIEW_RUNTIME_ERROR_HEADER) === '1') {
				return await this.handlePreviewRuntimeErrorResponse(response, bundled.code);
			}
			return response;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const isBundleError = errorMessage.includes('ERROR:');
			const locMatch = errorMessage.match(/([^\s:]+):(\d+):(\d+):\s*ERROR:\s*(.*)/);

			const serverError: ServerError = {
				id: crypto.randomUUID(),
				timestamp: Date.now(),
				type: isBundleError ? 'bundle' : 'runtime',
				message: cleanBuildErrorMessage(locMatch ? locMatch[4] : errorMessage),
				location: locMatch
					? {
							file: locMatch[1],
							line: Number(locMatch[2]),
							column: Number(locMatch[3]) + 1,
						}
					: undefined,
				dependencyErrors:
					(error instanceof BundleDependencyError ? error.dependencyErrors : undefined) ?? parseDependencyErrorsFromMessage(errorMessage),
			};

			await this.broadcastError(serverError).catch(() => {});
			console.error('Server code execution error:', error);
			return Response.json({ error: errorMessage, serverError }, { status: 500 });
		}
	}

	// =============================================================================
	// Private Methods
	// =============================================================================

	private matchRoutePattern(pathname: string, pattern: string): boolean {
		const escaped = pattern.replaceAll(/[.+?^${}()|[\]\\]/g, String.raw`\$&`);
		const regexString = '^' + escaped.replaceAll('*', '.*') + '$';
		return new RegExp(regexString).test(pathname);
	}

	private getExtension(path: string): string {
		const match = path.match(/\.[^./]+$/);
		return match ? match[0].toLowerCase() : '';
	}

	private getContentType(extension: string): string {
		const contentTypes: Record<string, string> = {
			'.css': 'text/css',
			'.gif': 'image/gif',
			'.html': 'text/html',
			'.jpeg': 'image/jpeg',
			'.jpg': 'image/jpeg',
			'.json': 'application/json',
			'.js': 'application/javascript',
			'.mjs': 'application/javascript',
			'.png': 'image/png',
			'.svg': 'image/svg+xml',
			'.webp': 'image/webp',
		};
		return contentTypes[extension] || 'text/plain';
	}
	private async serveHtmlFile(textContent: string, filePath: string, url: URL, ideOrigin: string, viteFs: FileSystem): Promise<Response> {
		const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
		const wsUrl = `${protocol}//${url.host}/__ws`;
		const bootVersion = await this.getBootVersion();
		const html = await processHTML(textContent, filePath, {
			fs: viteFs,
			projectRoot: this.projectRoot,
			wsUrl,
			ideOrigin,
			projectId: this.projectId,
			bootVersion,
			scriptIntegrityHashes,
		});
		return new Response(html, {
			headers: {
				'Content-Type': 'text/html',
				'Cache-Control': 'no-cache',
				'Content-Security-Policy': buildPreviewCsp(ideOrigin),
				'Referrer-Policy': 'no-referrer',
				'X-Robots-Tag': PREVIEW_ROBOTS_HEADER_VALUE,
			},
		});
	}

	private async handleNotFoundFallback(url: URL, ideOrigin: string, notFoundHandling: string | undefined): Promise<Response | undefined> {
		const viteFs: FileSystem = {
			readFile: (path: string) => fs.readFile(path),
			access: (path: string) => fs.access(path),
		};

		if (notFoundHandling === 'single-page-application') {
			try {
				const indexPath = `${this.projectRoot}/index.html`;
				const content = await fs.readFile(indexPath);
				const textContent = typeof content === 'string' ? content : new TextDecoder().decode(content);
				return this.serveHtmlFile(textContent, '/index.html', url, ideOrigin, viteFs);
			} catch {
				return undefined;
			}
		}

		if (notFoundHandling === '404-page') {
			const pathname = url.pathname;
			const segments = pathname.split('/').filter(Boolean);

			for (let index = segments.length; index >= 0; index--) {
				const directory = index === 0 ? '' : '/' + segments.slice(0, index).join('/');
				const notFoundPath = `${this.projectRoot}${directory}/404.html`;
				try {
					const content = await fs.readFile(notFoundPath);
					const textContent = typeof content === 'string' ? content : new TextDecoder().decode(content);
					const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
					const wsUrl = `${protocol}//${url.host}/__ws`;
					const bootVersion = await this.getBootVersion();
					const html = await processHTML(textContent, `${directory}/404.html`, {
						fs: viteFs,
						projectRoot: this.projectRoot,
						wsUrl,
						ideOrigin,
						projectId: this.projectId,
						bootVersion,
						scriptIntegrityHashes,
					});
					return new Response(html, {
						status: 404,
						headers: {
							'Content-Type': 'text/html',
							'Cache-Control': 'no-cache',
							'Content-Security-Policy': buildPreviewCsp(ideOrigin),
							'Referrer-Policy': 'no-referrer',
							'X-Robots-Tag': PREVIEW_ROBOTS_HEADER_VALUE,
						},
					});
				} catch {
					// 404.html not found at this level, try parent
				}
			}
			return undefined;
		}

		return undefined;
	}

	private async handleHtmlRedirects(url: URL, filePath: string, htmlHandling = 'auto-trailing-slash'): Promise<Response | undefined> {
		if (htmlHandling === 'none') {
			return undefined;
		}

		const extension = this.getExtension(filePath);
		if (extension && extension !== '.html') {
			return undefined;
		}

		const pathname = filePath;
		const hasTrailingSlash = pathname.endsWith('/') && pathname !== '/';

		if (htmlHandling === 'force-trailing-slash') {
			if (!hasTrailingSlash && pathname !== '/') {
				try {
					await fs.access(`${this.projectRoot}${pathname}/index.html`);
					const redirectUrl = new URL(url);
					redirectUrl.pathname = `${pathname}/`;
					return Response.redirect(redirectUrl.toString(), 308);
				} catch {
					// No directory/index.html
				}
			}
			return undefined;
		}

		if (htmlHandling === 'drop-trailing-slash') {
			if (hasTrailingSlash) {
				const withoutSlash = pathname.slice(0, -1);
				try {
					await fs.access(`${this.projectRoot}${withoutSlash}.html`);
					const redirectUrl = new URL(url);
					redirectUrl.pathname = withoutSlash;
					return Response.redirect(redirectUrl.toString(), 308);
				} catch {
					// No .html file
				}
			}
			return undefined;
		}

		// "auto-trailing-slash"
		if (!hasTrailingSlash && pathname !== '/') {
			try {
				await fs.access(`${this.projectRoot}${pathname}/index.html`);
				const redirectUrl = new URL(url);
				redirectUrl.pathname = `${pathname}/`;
				return Response.redirect(redirectUrl.toString(), 308);
			} catch {
				// No directory/index.html
			}
		} else if (hasTrailingSlash) {
			const withoutSlash = pathname.slice(0, -1);
			let hasIndexHtml = false;
			try {
				await fs.access(`${this.projectRoot}${pathname}index.html`);
				hasIndexHtml = true;
			} catch {
				// No index.html in directory
			}
			if (!hasIndexHtml) {
				try {
					await fs.access(`${this.projectRoot}${withoutSlash}.html`);
					const redirectUrl = new URL(url);
					redirectUrl.pathname = withoutSlash;
					return Response.redirect(redirectUrl.toString(), 308);
				} catch {
					// No .html file either
				}
			}
		}

		return undefined;
	}

	private async loadTsconfigRaw(): Promise<string | undefined> {
		try {
			const content = await fs.readFile(`${this.projectRoot}/tsconfig.json`, 'utf8');
			const tsConfig: NonNullable<Parameters<typeof toEsbuildTsconfigRaw>[0]> = parseJsonc(content);

			if (!tsConfig.compilerOptions) {
				try {
					const appContent = await fs.readFile(`${this.projectRoot}/tsconfig.app.json`, 'utf8');
					const appTsConfig: NonNullable<Parameters<typeof toEsbuildTsconfigRaw>[0]> = parseJsonc(appContent);
					return toEsbuildTsconfigRaw(appTsConfig);
				} catch {
					return undefined;
				}
			}

			return toEsbuildTsconfigRaw(tsConfig);
		} catch {
			return undefined;
		}
	}

	private async loadKnownDependencies(): Promise<Map<string, string>> {
		try {
			const raw = await fs.readFile(`${this.projectRoot}/package.json`, 'utf8');
			const packageJson: { dependencies?: Record<string, string> } = JSON.parse(raw);
			if (packageJson.dependencies && typeof packageJson.dependencies === 'object') {
				return new Map(Object.entries(packageJson.dependencies));
			}
		} catch {
			// No package.json or parse error
		}
		return new Map();
	}

	private async handlePreviewRuntimeErrorResponse(response: Response, bundledCode: string | undefined): Promise<Response> {
		let errorMessage = 'Worker runtime error';
		let stack: string | undefined;

		try {
			const body: unknown = await response.json();
			if (typeof body === 'object' && body !== undefined && body !== null) {
				if ('message' in body && typeof body.message === 'string') {
					errorMessage = body.message;
				}
				if ('stack' in body && typeof body.stack === 'string') {
					stack = body.stack;
				}
			}
		} catch {
			// Keep fallback message when the internal wrapper response is malformed.
		}

		const mappedLocation = resolveOriginalLocationFromStack(stack, bundledCode);
		const serverError: ServerError = {
			id: crypto.randomUUID(),
			timestamp: Date.now(),
			type: 'runtime',
			message: errorMessage,
			location: mappedLocation,
		};

		await this.broadcastError(serverError).catch(() => {});
		return Response.json({ error: errorMessage, serverError }, { status: 500 });
	}

	private async broadcastError(error: ServerError): Promise<void> {
		await this.broadcastMessage({ type: 'server-error', error });
	}

	private async broadcastMessage(message: ServerMessage): Promise<void> {
		const coordinatorStub = coordinatorNamespace.getByName(`project:${this.projectId}`);
		await coordinatorStub.sendMessage(message);
	}

	private async getBootVersion(): Promise<number> {
		const coordinatorStub = coordinatorNamespace.getByName(`project:${this.projectId}`);
		return coordinatorStub.getUpdateVersion();
	}

	private async hashContent(content: string): Promise<string> {
		const encoder = new TextEncoder();
		const data = encoder.encode(content);
		const hashBuffer = await crypto.subtle.digest('SHA-256', data);
		const hashArray = [...new Uint8Array(hashBuffer)];
		return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
	}

	private async collectFilesForBundle(directory: string, base = ''): Promise<Record<string, string>> {
		const files: Record<string, string> = {};
		try {
			const entries = await fs.readdir(directory, { withFileTypes: true });
			const results = await Promise.all(
				entries
					.filter((entry: { name: string }) => !HIDDEN_ENTRIES.has(entry.name))
					.map(async (entry: { name: string; isDirectory(): boolean }) => {
						const relativePath = base ? `${base}/${entry.name}` : entry.name;
						const fullPath = `${directory}/${entry.name}`;
						if (entry.isDirectory()) {
							return this.collectFilesForBundle(fullPath, relativePath);
						} else {
							const content = await fs.readFile(fullPath, 'utf8');
							return { [relativePath]: content };
						}
					}),
			);
			for (const result of results) {
				Object.assign(files, result);
			}
		} catch (error) {
			if (base === '') {
				console.error('collectFilesForBundle error:', error);
			}
		}
		return files;
	}
}
