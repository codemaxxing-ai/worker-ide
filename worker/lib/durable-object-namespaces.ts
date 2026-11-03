import { exports } from 'cloudflare:workers';

import { withRetry } from './do-retry-proxy';

/**
 * Creates a lazily-initialized, retry-wrapped namespace.
 *
 * The actual `withRetry(getNamespace())` call is deferred until the first
 * property access on the returned proxy. This avoids "Cannot create proxy
 * with a non-object as target" errors when `exports.SomeDO` is `undefined`
 * during early module evaluation.
 */
function lazyNamespace<T extends Rpc.DurableObjectBranded>(getNamespace: () => DurableObjectNamespace<T>): DurableObjectNamespace<T> {
	let cached: DurableObjectNamespace<T> | undefined;

	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Lazy proxy: the empty object is replaced by real namespace delegation on first access.
	return new Proxy({} as DurableObjectNamespace<T>, {
		get(_target, property, receiver) {
			cached ??= withRetry(getNamespace());
			return Reflect.get(cached, property, receiver);
		},
	});
}

/**
 * Filesystem Durable Object namespace with automatic retry.
 * Used for all file system and git operations.
 */
export const filesystemNamespace = lazyNamespace(() => exports.DurableObjectFilesystem);

/**
 * Project Coordinator Durable Object namespace with automatic retry.
 * Used for HMR broadcasts, WebSocket messages, and real-time collaboration.
 */
export const coordinatorNamespace = lazyNamespace(() => exports.ProjectCoordinatorV2);

/**
 * Agent Runner Durable Object namespace with automatic retry.
 * Used for running AI agent loops independently of client connections.
 */
export const agentRunnerNamespace = lazyNamespace(() => exports.AgentRunner);

/**
 * Project Metadata Durable Object namespace with automatic retry.
 * Used for per-project metadata (storage usage tracking, etc.).
 */
export const projectMetadataNamespace = lazyNamespace(() => exports.ProjectMetadata);

export const organizationContainerCapacityNamespace = lazyNamespace(() => exports.OrganizationContainerCapacity);
