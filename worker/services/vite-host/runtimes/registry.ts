/**
 * Framework runtime registry.
 *
 * Preview and deployment use the same manifest-based framework selection and
 * shared Worker/Container session decision.
 */
import { isVinextProject } from '../vinext-detection';
import { containerVinextRuntime, containerViteRuntime } from './container-vite';
import { reactSpaRuntime } from './react-spa';
import { vinextRuntime } from './vinext';

import type { FrameworkRuntime, ProjectProbe } from './types';
import type { RuntimeBackend } from '@shared/runtime-status';

/** Registered framework adapters and their explicitly selected native fallbacks. */
const RUNTIMES: readonly FrameworkRuntime[] = [containerVinextRuntime, containerViteRuntime, vinextRuntime, reactSpaRuntime];

/** Framework detection starts on Workers unless the shared runtime decision selects a container. */
export function selectRuntime(probe: ProjectProbe, backend?: RuntimeBackend): FrameworkRuntime {
	const vinext = isVinextProject(probe.files);
	if (backend === 'container') return vinext ? containerVinextRuntime : containerViteRuntime;
	return vinext ? vinextRuntime : reactSpaRuntime;
}

/** Look up a runtime by id (used by surfaces that already resolved detection). */
export function getRuntimeById(id: string): FrameworkRuntime | undefined {
	return RUNTIMES.find((runtime) => runtime.id === id);
}
