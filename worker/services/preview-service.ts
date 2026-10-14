/**
 * Preview entry point (stateless worker side) — a thin runtime dispatcher.
 *
 * Every project resolves to a {@link FrameworkRuntime} via the registry (keyed on
 * a cheap package.json + tree probe). There is no special-cased legacy path:
 *  - an `artifact` runtime (vinext, …) retrieves its immutable build through the
 *    cacheable BuildArtifact Worker entrypoint;
 *  - a `stateless` runtime (the static React SPA + worker) serves the request
 *    inline.
 * The public API (`loadAssetSettings`, `routePreviewRequest`) is unchanged, so
 * `worker/index.ts` and the agent preview tool keep working without changes.
 */
import { parseJsonc } from '@shared/jsonc';
import { resolveAssetSettings } from '@shared/types';
import { isWorkerResourceLimit } from '@shared/worker-resource-budget';
import { fs } from '@worker/lib/project-fs';

import { filesystemNamespace } from '../lib/durable-object-namespaces';
import { buildDetectionProbe } from '../lib/preview-bootstrap';
import { finalizePreviewResponse } from '../lib/preview-response-headers';
import { previewTransitionScript } from '../lib/preview-transition-script';
import { toDurableObjectId } from '../lib/project-id';
import { withSpan } from '../lib/tracing';
import { selectRuntime } from './vite-host/runtimes/registry';
import { readRuntimeOverride, VITE_CONFIG_PATHS } from './vite-host/runtimes/runtime-selection';
import { serveVinextPreview } from './vite-host/runtimes/vinext-preview';

import type { PreviewBootstrap } from '../lib/preview-bootstrap';
import type { FrameworkRuntime } from './vite-host/runtimes/types';
import type { RuntimeDecision } from '@shared/runtime-status';
import type { ResolvedAssetSettings } from '@shared/types';

export class PreviewService {
	constructor(
		private readonly projectRoot: string,
		private readonly projectId: string,
	) {}

	/** Asset settings from the project's `wrangler.jsonc` (defaults when absent). */
	async loadAssetSettings(): Promise<ResolvedAssetSettings> {
		let raw: string | undefined;
		try {
			raw = await fs.readFile(`${this.projectRoot}/wrangler.jsonc`, 'utf8');
		} catch {
			raw = undefined;
		}
		const value = resolveWranglerAssetSettings(raw);
		return value;
	}

	/** Resolve the project's runtime and serve (or forward) the preview request. */
	async routePreviewRequest(
		request: Request,
		ideOrigin: string,
		preloadedAssetSettings?: ResolvedAssetSettings,
		snapshotHash?: string,
		bootstrap?: PreviewBootstrap,
	): Promise<Response> {
		return withSpan(
			'preview.route',
			async (span) => {
				const probe = bootstrap === undefined ? { files: await this.collectDetectionFiles() } : buildDetectionProbe(bootstrap);
				const project = filesystemNamespace.get(toDurableObjectId(filesystemNamespace, this.projectId));
				let decision = bootstrap?.runtimeDecision ?? (await project.getBuildRuntimeDecision(probe.files));
				const runtime = selectRuntime(probe, decision.backend);
				span.setAttribute('runtime.id', runtime.id);
				span.setAttribute('runtime.hosting', runtime.hosting);
				const navigation =
					request.method === 'GET' && (new URL(request.url).pathname === '/' || request.headers.get('Accept')?.includes('text/html'));
				if (navigation) await project.reportRuntimeStatus('preview', decision, 'starting');
				const assetSettings = preloadedAssetSettings ?? (await this.loadAssetSettings());
				try {
					// Dependency/source edits can select a container on a module subrequest.
					// Warm its document before notifying the already loaded preview to switch.
					if (!navigation && decision.backend === 'container' && request.method === 'GET') {
						const status = await project.getRuntimeStatus();
						if (
							status.preview.backend !== 'container' ||
							status.preview.phase !== 'ready' ||
							status.preview.generation !== decision.generation
						) {
							await project.reportRuntimeStatus('preview', decision, 'starting');
							const readyUrl = new URL(request.url);
							readyUrl.pathname = '/';
							readyUrl.search = '';
							const ready = await this.serve(
								runtime,
								new Request(readyUrl, { headers: request.headers }),
								ideOrigin,
								assetSettings,
								snapshotHash,
							);
							await project.reportRuntimeStatus('preview', decision, ready.ok ? 'ready' : 'error');
							await ready.body?.cancel();
						}
					}
					const response = await this.serve(runtime, request, ideOrigin, assetSettings, snapshotHash);
					if (navigation) await project.reportRuntimeStatus('preview', decision, response.ok ? 'ready' : 'error');
					return this.describeRuntime(response, decision, ideOrigin);
				} catch (error) {
					if (decision.backend !== 'worker' || !isWorkerResourceLimit(error) || readRuntimeOverride(probe.files) === 'worker') {
						await project.reportRuntimeStatus('preview', decision, 'error');
						throw error;
					}
					// Only retry preview GET/HEAD requests. Never replay application mutations.
					if (request.method !== 'GET' && request.method !== 'HEAD') throw error;
					decision = await project.promoteBuildRuntime('preview');
					const native = selectRuntime(probe, 'container');
					const readyUrl = new URL(request.url);
					readyUrl.pathname = '/';
					readyUrl.search = '';
					try {
						const ready = await this.serve(
							native,
							new Request(readyUrl, { headers: request.headers }),
							ideOrigin,
							assetSettings,
							snapshotHash,
						);
						await project.reportRuntimeStatus('preview', decision, ready.ok ? 'ready' : 'error');
						if (navigation && new URL(request.url).pathname === '/') return this.describeRuntime(ready, decision, ideOrigin);
						await ready.body?.cancel();
						return this.describeRuntime(await this.serve(native, request, ideOrigin, assetSettings, snapshotHash), decision, ideOrigin);
					} catch (nativeError) {
						await project.reportRuntimeStatus('preview', decision, 'error');
						throw nativeError;
					}
				}
			},
			{ 'project.id': this.projectId, 'request.path': new URL(request.url).pathname },
		);
	}

	/** Serve through the selected host after authorization and runtime selection. */
	private async serve(
		runtime: FrameworkRuntime,
		request: Request,
		ideOrigin: string,
		assetSettings: ResolvedAssetSettings,
		snapshotHash?: string,
	): Promise<Response> {
		if (runtime.hosting === 'artifact') {
			if (snapshotHash === undefined) throw new Error('Missing snapshot hash for build runtime');
			return finalizePreviewResponse(
				await serveVinextPreview({ request, projectId: this.projectId, projectRoot: this.projectRoot, ideOrigin, snapshotHash, runtime }),
				{ ideOrigin },
			);
		}
		return runtime.serve(request, { projectRoot: this.projectRoot, projectId: this.projectId, ideOrigin, assetSettings });
	}

	private describeRuntime(response: Response, decision: RuntimeDecision, ideOrigin: string): Response {
		if (response.status === 101) return response;
		const headers = new Headers(response.headers);
		headers.set('X-Worker-Ide-Runtime', decision.backend);
		const described = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
		if (!response.ok || !response.headers.get('Content-Type')?.includes('text/html')) return described;
		const script = `<script>${previewTransitionScript(decision, ideOrigin, this.projectId)}</script>`;
		return new HTMLRewriter()
			.on('head', {
				element(element) {
					element.prepend(script, { html: true });
				},
			})
			.transform(described);
	}

	/**
	 * Minimal snapshot for runtime detection: the manifest plus entry/router probes.
	 *
	 * Every read here is a cross-Durable-Object round trip to the filesystem DO
	 * (~hundreds of ms of pure latency each), so they are issued CONCURRENTLY and
	 * awaited once via `Promise.all` rather than sequentially. Sequential awaits
	 * turned a ~150ms-of-work probe into ~5 serial round trips (~700ms+); batching
	 * collapses that to a single round-trip's latency. Semantics are unchanged: a
	 * missing `package.json` means "not detectable" (empty result), `index.html`
	 * is optional, and each router directory contributes its first entry.
	 */
	private async collectDetectionFiles(): Promise<Record<string, string>> {
		const routerDirectories = ['app', 'pages', 'src'];
		const [packageJson, indexHtml, configurationEntries, ...directoryEntries] = await Promise.all([
			fs.readFile(`${this.projectRoot}/package.json`, 'utf8').catch(() => {}),
			fs.readFile(`${this.projectRoot}/index.html`, 'utf8').catch(() => {}),
			Promise.all(VITE_CONFIG_PATHS.map(async (path) => [path, await fs.readFile(`${this.projectRoot}/${path}`, 'utf8').catch(() => {})])),
			...routerDirectories.map((directory) => fs.readdir(`${this.projectRoot}/${directory}`).catch(() => [])),
		]);

		const files: Record<string, string> = {};
		if (packageJson === undefined) {
			// No manifest — nothing to detect against.
			return files;
		}
		files['/package.json'] = packageJson;
		for (const [path, content] of configurationEntries) if (path !== undefined && content !== undefined) files[`/${path}`] = content;
		if (indexHtml !== undefined) {
			files['/index.html'] = indexHtml;
		}
		for (const [index, directory] of routerDirectories.entries()) {
			const entries = directoryEntries[index];
			if (entries.length > 0) {
				files[`/${directory}/${entries[0]}`] = '';
			}
		}
		return files;
	}
}

/** Resolve asset settings from raw `wrangler.jsonc` contents (defaults when absent/invalid). */
function resolveWranglerAssetSettings(rawWranglerJsonc: string | undefined): ResolvedAssetSettings {
	if (rawWranglerJsonc === undefined) {
		return resolveAssetSettings();
	}
	try {
		const wrangler: { assets?: Record<string, unknown> } = parseJsonc(rawWranglerJsonc);
		return resolveAssetSettings(wrangler.assets);
	} catch {
		return resolveAssetSettings();
	}
}
