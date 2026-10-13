/**
 * Framework runtime registry.
 *
 * Detection is keyed off a cheap project probe (package.json + tree) and used by
 * every surface — the preview router, cacheable build entrypoint, and deploy
 * workflow — so a project resolves to the same runtime everywhere. Runtimes are
 * tried in order; the first to claim the project wins. Projects that no runtime
 * claims fall back to the legacy esbuild preview/deploy pipeline.
 */
import { containerVinextRuntime, containerViteRuntime } from './container-vite';
import { reactSpaRuntime } from './react-spa';
import { vinextRuntime } from './vinext';

import type { FrameworkRuntime, ProjectProbe } from './types';

/**
 * All registered runtimes, in detection-priority order. The last entry
 * ({@link reactSpaRuntime}) is the catch-all, so every project resolves to a
 * runtime — there is no separate legacy pipeline.
 */
const RUNTIMES: readonly FrameworkRuntime[] = [containerVinextRuntime, containerViteRuntime, vinextRuntime, reactSpaRuntime];

/** The runtime that claims this project (always defined — react-spa is catch-all). */
export function selectRuntime(probe: ProjectProbe): FrameworkRuntime {
	return RUNTIMES.find((runtime) => runtime.detect(probe)) ?? reactSpaRuntime;
}

/** Look up a runtime by id (used by surfaces that already resolved detection). */
export function getRuntimeById(id: string): FrameworkRuntime | undefined {
	return RUNTIMES.find((runtime) => runtime.id === id);
}
