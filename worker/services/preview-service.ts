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
import { fs } from '@worker/lib/project-fs';

import { buildDetectionProbe } from '../lib/preview-bootstrap';
import { finalizePreviewResponse } from '../lib/preview-response-headers';
import { withSpan } from '../lib/tracing';
import { selectRuntime } from './vite-host/runtimes/registry';
import { serveVinextPreview } from './vite-host/runtimes/vinext-preview';

import type { PreviewBootstrap } from '../lib/preview-bootstrap';
import type { FrameworkRuntime } from './vite-host/runtimes/types';
import type { ResolvedAssetSettings } from '@shared/types';

export class PreviewService {
	constructor(
		private readonly projectRoot: string,
		private readonly projectId: string,
	) {}

	/**
	 * Seed the runtime + asset-settings memos from a single preview bootstrap
	 * snapshot (see {@link PreviewBootstrap}), so the burst of subrequests behind
	 * a page load serve without any further cross-DO reads. The `PreviewService`
	 * instance is cached per project; seeding with a fresh snapshot is strictly
	 * better than letting the memos lazily re-read the tree.
	 */
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
				const runtime = bootstrap === undefined ? await this.resolveRuntime() : selectRuntime(buildDetectionProbe(bootstrap));
				span.setAttribute('runtime.id', runtime.id);
				span.setAttribute('runtime.hosting', runtime.hosting);

				if (runtime.hosting === 'artifact') {
					if (snapshotHash === undefined) throw new Error('Missing snapshot hash for build runtime');
					return finalizePreviewResponse(
						await serveVinextPreview({
							request,
							projectId: this.projectId,
							projectRoot: this.projectRoot,
							ideOrigin,
							snapshotHash,
							runtime,
						}),
						{ ideOrigin },
					);
				}

				const assetSettings = preloadedAssetSettings ?? (await this.loadAssetSettings());
				return runtime.serve(request, {
					projectRoot: this.projectRoot,
					projectId: this.projectId,
					ideOrigin,
					assetSettings,
				});
			},
			{ 'project.id': this.projectId, 'request.path': new URL(request.url).pathname },
		);
	}

	/**
	 * Resolve the project's runtime from a minimal probe when the request did not
	 * already carry the one-round-trip preview bootstrap.
	 */
	private async resolveRuntime(): Promise<FrameworkRuntime> {
		const probe = await withSpan('preview.detect', () => this.collectDetectionFiles());
		return selectRuntime({ files: probe });
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
		const [packageJson, indexHtml, ...directoryEntries] = await Promise.all([
			fs.readFile(`${this.projectRoot}/package.json`, 'utf8').catch(() => {}),
			fs.readFile(`${this.projectRoot}/index.html`, 'utf8').catch(() => {}),
			...routerDirectories.map((directory) => fs.readdir(`${this.projectRoot}/${directory}`).catch(() => [])),
		]);

		const files: Record<string, string> = {};
		if (packageJson === undefined) {
			// No manifest — nothing to detect against.
			return files;
		}
		files['/package.json'] = packageJson;
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
