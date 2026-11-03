/**
 * Static React (SPA + worker) framework runtime — the registry's catch-all.
 *
 * Any project a build-host runtime (e.g. vinext) does not claim resolves here: a
 * classic `index.html` + `src/` single-page app with an optional `worker/` API.
 * Its preview is cheap and per-request (no warm build), so it is `stateless` and
 * served inline in the worker by {@link StaticReactPreview}.
 */
import type { StatelessFrameworkRuntime, StatelessPreviewContext } from './types';

class ReactSpaRuntime implements StatelessFrameworkRuntime {
	readonly id = 'react-spa';
	readonly hosting = 'stateless' as const;

	async serve(request: Request, context: StatelessPreviewContext): Promise<Response> {
		// Lazily import the static preview so the registry stays light: its module
		// graph pulls in chobitsu (which uses eval), kept out of boot-time code.
		const { StaticReactPreview } = await import('../../static-preview');
		const preview = new StaticReactPreview(context.projectRoot, context.projectId);
		return preview.routePreviewRequest(request, context.ideOrigin, context.assetSettings);
	}
}

export const reactSpaRuntime: StatelessFrameworkRuntime = new ReactSpaRuntime();
