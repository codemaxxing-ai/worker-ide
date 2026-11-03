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
import { declaresVinext } from './runtime-selection';
import { vinextRuntime } from './vinext';

import type { FrameworkRuntime, ProjectProbe } from './types';
import type { RuntimeBackend } from '@shared/runtime-status';

/** Registered framework adapters and their explicitly selected native fallbacks. */
const RUNTIMES: readonly FrameworkRuntime[] = [containerVinextRuntime, containerViteRuntime, vinextRuntime, reactSpaRuntime];

/** Framework detection starts on Workers unless the shared runtime decision selects a container. */
export function selectRuntime(probe: ProjectProbe, backend?: RuntimeBackend): FrameworkRuntime {
	if (backend === 'container') return declaresVinext(probe.files) ? containerVinextRuntime : containerViteRuntime;
	return declaresVinext(probe.files) ? vinextRuntime : reactSpaRuntime;
}

/** Look up a runtime by id (used by surfaces that already resolved detection). */
export function getRuntimeById(id: string): FrameworkRuntime | undefined {
	return RUNTIMES.find((runtime) => runtime.id === id);
}
