/**
 * Cacheable build-artifact entrypoint.
 *
 * Build output is addressed exclusively by immutable input: the project identity,
 * runtime, build mode, source snapshot hash, and this artifact format version.
 * Workers Cache therefore owns reuse and request collapsing; no Worker or Durable
 * Object memory is used as build state.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';

import { SNAPSHOT_EXCLUDED_DIRECTORIES } from '@shared/constants';

import { getRuntimeById } from './runtimes/registry';
import { parseRuntimeBuild } from './runtimes/runtime-build';
import { filesystemNamespace } from '../../lib/durable-object-namespaces';
import { toDurableObjectId } from '../../lib/project-id';
import { hashSnapshot } from '../../lib/snapshot-hash';
import { withSpan } from '../../lib/tracing';

import type { BuildMode } from './runtimes/types';

const BUILD_ARTIFACT_FORMAT_VERSION = 'v1';
const BUILD_CACHE_SECONDS = 60 * 60 * 24;

export interface BuildArtifactProperties {
	projectId: string;
	projectRoot: string;
}

function parseBuildMode(value: string | undefined): BuildMode | undefined {
	if (value === 'preview' || value === 'deploy') return value;
	return undefined;
}

/** Build a canonical immutable URL so equivalent requests share one cache key. */
export function buildArtifactUrl(runtimeId: string, mode: BuildMode, snapshotHash: string): string {
	const url = new URL('https://build-artifact.internal/build');
	url.searchParams.set('format', BUILD_ARTIFACT_FORMAT_VERSION);
	url.searchParams.set('mode', mode);
	url.searchParams.set('runtime', runtimeId);
	url.searchParams.set('snapshot', snapshotHash);
	return url.toString();
}

/**
 * Only this fetch entrypoint has Workers Cache enabled. It is invoked through a
 * loopback binding after preview authorization, never as a public route.
 */
export class BuildArtifact extends WorkerEntrypoint<Env, BuildArtifactProperties> {
	async fetch(request: Request): Promise<Response> {
		if (request.method !== 'GET') {
			return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET', 'Cache-Control': 'no-store' } });
		}
		const cache = caches.default;
		const cached = await cache.match(request);
		if (cached !== undefined) {
			return cached;
		}
		const url = new URL(request.url);
		const runtimeId = url.searchParams.get('runtime') ?? undefined;
		const mode = parseBuildMode(url.searchParams.get('mode') ?? undefined);
		const requestedHash = url.searchParams.get('snapshot') ?? undefined;
		if (
			runtimeId === undefined ||
			mode === undefined ||
			requestedHash === undefined ||
			url.searchParams.get('format') !== BUILD_ARTIFACT_FORMAT_VERSION
		) {
			return new Response('Invalid build artifact request', { status: 400, headers: { 'Cache-Control': 'no-store' } });
		}
		const runtime = getRuntimeById(runtimeId);
		if (runtime === undefined || runtime.hosting !== 'artifact') {
			return new Response('Unsupported build runtime', { status: 400, headers: { 'Cache-Control': 'no-store' } });
		}

		const response = await withSpan(
			'buildArtifact.build',
			async (span) => {
				const filesystemStub = filesystemNamespace.get(toDurableObjectId(filesystemNamespace, this.ctx.props.projectId));
				using snapshot = await filesystemStub.collectProjectSnapshot(SNAPSHOT_EXCLUDED_DIRECTORIES);
				const snapshotHash = await hashSnapshot(snapshot);
				if (snapshotHash !== requestedHash) {
					// An edit landed after preview bootstrap. Never cache a build under the
					// wrong source hash; the caller retries after its next bootstrap.
					return new Response('Snapshot changed', { status: 409, headers: { 'Cache-Control': 'no-store' } });
				}
				span.setAttribute('build.mode', mode);
				span.setAttribute('runtime.id', runtimeId);
				span.setAttribute('snapshot.hash', snapshotHash.slice(0, 12));
				const serialized = await this.env.VITE_HOST.build(snapshot, runtimeId, { hostDevelopment: mode === 'preview' });
				if (parseRuntimeBuild(JSON.parse(serialized)) === undefined) {
					throw new Error('vite-host returned a malformed build payload');
				}
				return new Response(serialized, {
					headers: {
						'Cache-Control': `public, max-age=${BUILD_CACHE_SECONDS}, immutable`,
						'Content-Type': 'application/json',
						'Cache-Tag': `build:${this.ctx.props.projectId}`,
					},
				});
			},
			{ 'project.id': this.ctx.props.projectId },
		);
		if (response.ok) {
			await cache.put(request, response.clone());
		}
		return response;
	}
}
