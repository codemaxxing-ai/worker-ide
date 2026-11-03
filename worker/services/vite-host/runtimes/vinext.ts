/**
 * vinext App Router on Vite) framework runtime — the light, DO-facing
 * half.
 *
 * This module holds only what the preview Durable Object needs:
 * request routing across an already-built module set, the server isolate's
 * compatibility flags, and the browser HMR glue. The expensive build (esbuild +
 * the vendored React/RSC source) lives in `./vinext-build`, which runs in the
 * dedicated `vite-host` worker so this module — and anything that imports the
 * runtime registry — never loads esbuild-wasm or the ~20 MB of vendored source.
 */
import { buildHmrGlue } from './shared';
import { routeAppRequest } from '../runtime/app-runtime';

import type { ArtifactFrameworkRuntime, RuntimeRouteContext } from './types';

/**
 * IDE-managed config files excluded from the vinext build input.
 *
 * vinext treats the presence of a wrangler config as a Cloudflare deploy target
 * and then requires `@cloudflare/vite-plugin` in the Vite config. The IDE's
 * vinext build instead uses its own loader-based runtime (and a separate deploy
 * path), so it must not surface the wrangler config to the framework build.
 * These files still live on the project filesystem for the wrangler overlay,
 * `readBindingsConfig`, and external `vinext deploy`.
 */
const IDE_MANAGED_CONFIG_FILES: ReadonlySet<string> = new Set(['/wrangler.jsonc', '/wrangler.json', '/wrangler.toml']);

/** Remove IDE-managed Cloudflare config from a build snapshot (see {@link IDE_MANAGED_CONFIG_FILES}). */
export function stripIdeManagedConfig(snapshot: Record<string, string>): Record<string, string> {
	const filtered: Record<string, string> = {};
	for (const [path, contents] of Object.entries(snapshot)) {
		if (!IDE_MANAGED_CONFIG_FILES.has(path)) {
			filtered[path] = contents;
		}
	}
	return filtered;
}

class VinextRuntime implements ArtifactFrameworkRuntime {
	readonly id = 'vinext';
	readonly hosting = 'artifact' as const;
	readonly serverCompatibilityFlags = ['nodejs_compat', 'enable_nodejs_fs_module'] as const;

	route(request: Request, context: RuntimeRouteContext): Promise<Response> {
		return routeAppRequest(request, { clientOutput: context.clientOutput, server: context.getServer(), buildId: context.buildId });
	}

	hmrGlue(): string {
		return buildHmrGlue({
			// The client build's `import.meta.hot` resolves to this hot context, so
			// vinext's client HMR runtime attaches to the preview runtime's event bus.
			extraSetup: `window.__vinext_client_hot__ = runtime.createHotContext('vinext-client-runtime');`,
			// Server-component change: vinext re-fetches the route's RSC payload and
			// reconciles it in place (hmrReplaceTree), preserving client state.
			softRefreshBody: `if (window.__vinext_client_hot__) { runtime.emitEvent('rsc:update', {}); return; } location.reload();`,
		});
	}
}

export const vinextRuntime: ArtifactFrameworkRuntime = new VinextRuntime();
