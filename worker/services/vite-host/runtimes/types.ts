/**
 * Framework runtime abstraction for the in-worker Vite Surface Host.
 *
 * A {@link FrameworkRuntime} encapsulates everything framework-specific about a
 * project type — detection, build, preview serving, HMR, and deploy packaging —
 * behind one interface. vinext and plain React are implemented as adapters;
 * adding Svelte or TanStack Start later means implementing this interface and
 * registering it (see `registry.ts`). The cacheable build entrypoint, preview router,
 * and deploy workflow stay generic and delegate to the selected runtime.
 */
import type { ServerFetcher } from '../runtime/app-runtime';
import type { ResolvedAssetSettings } from '@shared/types';

/** A cheap project snapshot for detection: `path -> contents` (leading slash optional). */
export interface ProjectProbe {
	files: Record<string, string>;
}

/** The output of building a project, shared by preview and deploy. */
export interface RuntimeBuild {
	/** Entry module name within {@link serverModules} (the server isolate's main). */
	mainModule: string;
	/** Server module set run in a `LOADER` isolate (SSR/RSC, or the API worker). */
	serverModules: Record<string, string>;
	/** Client build output, served as static assets. */
	clientOutput: Record<string, string>;
}

/** The immutable compiler target used in a build artifact cache key. */
export type BuildMode = 'preview' | 'deploy';

/** Context handed to a runtime when routing a preview request. */
export interface RuntimeRouteContext {
	clientOutput: Record<string, string>;
	/** Lazily instantiate (or reuse) the server isolate for this build. */
	getServer: () => ServerFetcher;
	projectRoot: string;
	/** Build identity (snapshot hash) used to tag client assets with an ETag for `304` revalidation. */
	buildId?: string;
}

/** Context handed to a stateless runtime to serve a preview request. */
export interface StatelessPreviewContext {
	projectRoot: string;
	projectId: string;
	ideOrigin: string;
	assetSettings: ResolvedAssetSettings;
}

interface BaseRuntime {
	/** Stable identifier (also used in cache keys + logs). */
	readonly id: string;
	/** Whether this runtime claims the given project. */
	detect(probe: ProjectProbe): boolean;
}

/**
 * A runtime whose build is expensive and routed through an immutable build
 * artifact (vinext, plain React on Vite, …). Workers Cache owns artifact reuse
 * and request collapsing while the runtime routes preview requests across it.
 *
 * The heavy build itself (esbuild + the vendored React/RSC source) is NOT part
 * of this interface — it runs in the dedicated `vite-host` worker (see
 * `runtimes/vinext-build.ts` and `auxiliary/vite-host`) so the request-serving
 * isolate never loads esbuild-wasm or the ~20 MB of vendored source.
 * This interface is the light artifact-facing contract: detection, request routing
 * across an already-built module set, and the browser HMR glue.
 */
export interface ArtifactFrameworkRuntime extends BaseRuntime {
	readonly hosting: 'artifact';
	/** Compatibility flags the built server isolate requires. */
	readonly serverCompatibilityFlags: readonly string[];
	/** Route a preview request across the build (static asset / SSR / SPA fallback). */
	route(request: Request, context: RuntimeRouteContext): Promise<Response>;
	/**
	 * Browser HMR glue injected (as a classic script) into preview HTML. It bridges
	 * the coordinator's `vinext:hmr` events to the framework's surgical update path.
	 */
	hmrGlue(): string;
}

/**
 * A runtime whose preview is cheap and per-request (no warm build), served
 * inline in the stateless worker — e.g. a static React SPA + worker. It owns its
 * own request routing.
 */
export interface StatelessFrameworkRuntime extends BaseRuntime {
	readonly hosting: 'stateless';
	serve(request: Request, context: StatelessPreviewContext): Promise<Response>;
}

export interface ContainerFrameworkRuntime extends BaseRuntime {
	readonly hosting: 'container';
	serve(request: Request, context: StatelessPreviewContext): Promise<Response>;
}

export type FrameworkRuntime = ArtifactFrameworkRuntime | StatelessFrameworkRuntime | ContainerFrameworkRuntime;
