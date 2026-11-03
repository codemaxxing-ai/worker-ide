/**
 * Preview entry point (stateless worker side) — a thin runtime dispatcher.
 *
 * Every project resolves to a {@link FrameworkRuntime} via the registry:
 *  - an `artifact` runtime (vinext, …) retrieves its immutable build through the
 *    cacheable BuildArtifact Worker entrypoint;
 *  - a `stateless` runtime (the static React SPA + worker) serves the request
 *    inline.
 */
import { parseJsonc } from '@shared/jsonc';
import { resolveAssetSettings } from '@shared/types';
import { workerFallbackReason } from '@shared/worker-runtime-error';

import { filesystemNamespace } from '../lib/durable-object-namespaces';
import { buildDetectionProbe, PREVIEW_BOOTSTRAP_INPUTS } from '../lib/preview-bootstrap';
import { finalizePreviewResponse } from '../lib/preview-response-headers';
import { previewTransitionScript } from '../lib/preview-transition-script';
import { toDurableObjectId } from '../lib/project-id';
import { withSpan } from '../lib/tracing';
import { selectRuntime } from './vite-host/runtimes/registry';
import { assertWorkerCapabilities } from './vite-host/runtimes/runtime-selection';
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

	/** Resolve the project's runtime and serve (or forward) the preview request. */
	async routePreviewRequest(request: Request, ideOrigin: string, preloadedBootstrap?: PreviewBootstrap): Promise<Response> {
		return withSpan(
			'preview.route',
			async (span) => {
				const project = filesystemNamespace.get(toDurableObjectId(filesystemNamespace, this.projectId));
				const bootstrap = preloadedBootstrap ?? (await project.collectPreviewBootstrap(PREVIEW_BOOTSTRAP_INPUTS));
				const probe = buildDetectionProbe(bootstrap);
				const snapshotHash = bootstrap.snapshotHash;
				let decision = bootstrap.runtimeDecision;
				const runtime = selectRuntime(probe, decision.backend);
				span.setAttribute('runtime.id', runtime.id);
				span.setAttribute('runtime.hosting', runtime.hosting);
				const navigation =
					request.method === 'GET' && (new URL(request.url).pathname === '/' || request.headers.get('Accept')?.includes('text/html'));
				if (navigation) await project.reportRuntimeStatus('preview', decision, 'starting');
				const assetSettings = resolveWranglerAssetSettings(bootstrap.wranglerJsonc);
				try {
					if (decision.backend === 'worker') assertWorkerCapabilities(probe.files);
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
					const fallbackReason = workerFallbackReason(error);
					if (decision.backend !== 'worker' || !fallbackReason || (request.method !== 'GET' && request.method !== 'HEAD')) {
						await project.reportRuntimeError('preview', decision, error instanceof Error ? error.message : String(error));
						throw error;
					}
					// Only retry preview GET/HEAD requests. Never replay application mutations.
					decision = await project.promoteBuildRuntime('preview', fallbackReason);
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
						await project.reportRuntimeError('preview', decision, nativeError instanceof Error ? nativeError.message : String(nativeError));
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
		snapshotHash: string,
	): Promise<Response> {
		if (runtime.hosting === 'artifact') {
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
