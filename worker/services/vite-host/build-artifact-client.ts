import { exports } from 'cloudflare:workers';

import { WorkerResourceLimitError } from '@shared/worker-resource-budget';

import { buildArtifactUrl } from './build-artifact';
import { parseRuntimeBuild } from './runtimes/runtime-build';

import type { BuildMode, RuntimeBuild } from './runtimes/types';

export interface BuildArtifactRequest {
	projectId: string;
	projectRoot: string;
	runtimeId: string;
	mode: BuildMode;
	snapshotHash: string;
}

/** Fetch a cacheable immutable build artifact through the internal Worker binding. */
export async function getBuildArtifact(input: BuildArtifactRequest): Promise<RuntimeBuild> {
	const response = await exports
		.BuildArtifact({ props: { projectId: input.projectId, projectRoot: input.projectRoot } })
		.fetch(new Request(buildArtifactUrl(input.runtimeId, input.mode, input.snapshotHash)));
	if (!response.ok) {
		if (response.headers.get('X-Worker-Ide-Resource-Limit') === '1') throw new WorkerResourceLimitError();
		throw new Error(response.status === 409 ? 'Project changed while preparing the preview. Refresh to retry.' : 'Failed to build project');
	}
	const build = parseRuntimeBuild(await response.json());
	if (build === undefined) throw new Error('Build artifact was malformed');
	return build;
}
