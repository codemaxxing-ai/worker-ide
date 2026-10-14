/**
 * Preview bootstrap: the single cross-Durable-Object round trip that primes a
 * preview request.
 *
 * Serving a preview needs a handful of project facts up front — does the project
 * exist, its `wrangler.jsonc` asset settings, and a cheap tree probe to select
 * the runtime. Each of those reads is a cross-DO RPC to the filesystem DO
 * (~hundreds of ms of pure latency, cross-region), so issuing them separately
 * (or even concurrently) pays that latency per call. {@link ProjectFilesystem.collectPreviewBootstrap}
 * does every read LOCALLY inside the DO (SQLite reads are ~0ms there) and returns
 * the whole snapshot in one message, collapsing ~7 round trips into one.
 *
 * This module holds the request/response contract plus the pure assembler that
 * turns the raw snapshot into a {@link ProjectProbe}. Detection knowledge (which
 * files/directories matter) lives here, next to the runtime registry it feeds —
 * the DO stays a generic reader that is told what to read.
 */
import { SNAPSHOT_EXCLUDED_DIRECTORIES } from '@shared/constants';

import { VITE_CONFIG_PATHS } from '../services/vite-host/runtimes/runtime-selection';

import type { ProjectProbe } from '../services/vite-host/runtimes/types';
import type { RuntimeDecision } from '@shared/runtime-status';

/**
 * What {@link ProjectFilesystem.collectPreviewBootstrap} reads, in root-relative
 * Workspace space (no `/project` mount prefix). Directories contribute their
 * first entry only, which is all the runtime probe needs.
 */
export interface PreviewBootstrapInputs {
	/** Root-relative path to the project manifest (e.g. `/package.json`). */
	packageJsonPath: string;
	/** Root-relative path to the HTML entry (e.g. `/index.html`). */
	indexHtmlPath: string;
	/** Root-relative path to the Wrangler config (e.g. `/wrangler.jsonc`). */
	wranglerPath: string;
	/** Root-relative router directories to probe (e.g. `app`, `pages`, `src`). */
	routerDirectories: string[];
	/** Directories excluded from the build-snapshot hash (see {@link PreviewBootstrap.snapshotHash}). */
	excludedDirectories: readonly string[];
	configurationPaths?: readonly string[];
}

/** The raw snapshot returned by a single preview bootstrap round trip. */
export interface PreviewBootstrap {
	/** Whether the project exists (mirrors {@link ProjectFilesystem.projectExists}). */
	exists: boolean;
	/** Raw `wrangler.jsonc` contents, or `undefined` when absent. */
	wranglerJsonc?: string;
	/** Raw `package.json` contents, or `undefined` when absent. */
	packageJson?: string;
	/** Raw `index.html` contents, or `undefined` when absent. */
	indexHtml?: string;
	/** First entry name per router directory (keyed by directory name); `undefined` when empty/missing. */
	routerFirstEntries: Record<string, string | undefined>;
	/**
	 * Build-cache hash of the current tree, computed LOCALLY in the filesystem DO
	 * during the same round trip. Passed to the preview host so it can probe its
	 * warm build cache WITHOUT a second cross-DO hop for the hash. Identical to
	 * `hashSnapshot(collectProjectSnapshot(excludedDirectories))`.
	 */
	snapshotHash: string;
	configurationFiles?: Record<string, string>;
	runtimeDecision?: RuntimeDecision;
}

/**
 * The fixed inputs for the preview bootstrap. Kept alongside the runtime
 * registry (its consumer) so detection heuristics have a single source of truth.
 */
export const PREVIEW_BOOTSTRAP_INPUTS: PreviewBootstrapInputs = {
	packageJsonPath: '/package.json',
	indexHtmlPath: '/index.html',
	wranglerPath: '/wrangler.jsonc',
	routerDirectories: ['app', 'pages', 'src'],
	excludedDirectories: SNAPSHOT_EXCLUDED_DIRECTORIES,
	configurationPaths: VITE_CONFIG_PATHS,
};

/**
 * Build the runtime detection probe from a bootstrap snapshot. Semantics match
 * the previous per-request reads: a missing `package.json` means "not
 * detectable" (empty probe → the default runtime), `index.html` is optional, and
 * each router directory contributes its first entry as an empty-content marker.
 */
export function buildDetectionProbe(bootstrap: PreviewBootstrap): ProjectProbe {
	const files: Record<string, string> = {};
	if (bootstrap.packageJson === undefined) {
		return { files };
	}
	files['/package.json'] = bootstrap.packageJson;
	Object.assign(files, bootstrap.configurationFiles);
	if (bootstrap.indexHtml !== undefined) {
		files['/index.html'] = bootstrap.indexHtml;
	}
	for (const [directory, firstEntry] of Object.entries(bootstrap.routerFirstEntries)) {
		if (firstEntry !== undefined) {
			files[`/${directory}/${firstEntry}`] = '';
		}
	}
	return { files };
}
