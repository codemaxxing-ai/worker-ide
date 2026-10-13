import { declaresVinext, selectBuildBackend } from './runtime-selection';
import { filesystemNamespace } from '../../../lib/durable-object-namespaces';
import { stripPreviewRequestCredentials } from '../../../lib/preview-request-headers';
import { finalizePreviewResponse } from '../../../lib/preview-response-headers';
import { toDurableObjectId } from '../../../lib/project-id';

import type { ContainerFrameworkRuntime, ProjectProbe, StatelessPreviewContext } from './types';

class ContainerViteRuntime implements ContainerFrameworkRuntime {
	readonly id: string;
	readonly hosting = 'container';
	constructor(private readonly framework: 'vinext' | 'spa') {
		this.id = framework === 'vinext' ? 'container-vinext' : 'container-vite';
	}

	detect(probe: ProjectProbe): boolean {
		return (
			selectBuildBackend(probe.files) === 'container' &&
			(this.framework === 'vinext' ? declaresVinext(probe.files) : !declaresVinext(probe.files))
		);
	}

	async serve(request: Request, context: StatelessPreviewContext): Promise<Response> {
		const url = new URL(request.url);
		const { StaticReactPreview } = await import('../../static-preview');
		const staticPreview = new StaticReactPreview(context.projectRoot, context.projectId);
		const bridgeScripts = ['/__chobitsu.js', '/__chobitsu-init.js', '/__element-picker.js'];
		if (bridgeScripts.includes(url.pathname))
			return finalizePreviewResponse(await staticPreview.serveFile(request, context.ideOrigin, context.assetSettings), {
				ideOrigin: context.ideOrigin,
			});
		if (this.framework === 'spa' && staticPreview.matchesRunWorkerFirst(url.pathname, context.assetSettings.run_worker_first))
			return staticPreview.routePreviewRequest(request, context.ideOrigin, context.assetSettings);
		const project = filesystemNamespace.get(toDurableObjectId(filesystemNamespace, context.projectId));
		const forwarded = new Request(request);
		stripPreviewRequestCredentials(forwarded.headers);
		// Keep HTTP streams and WebSocket upgrades on the DO's HTTP entrypoint.
		const response = await project.fetch(forwarded);
		if (response.status === 101 || !response.headers.get('Content-Type')?.includes('text/html'))
			return finalizePreviewResponse(response, { ideOrigin: context.ideOrigin });
		const html = await response.text();
		const configuration = JSON.stringify({ ideOrigin: context.ideOrigin, projectId: context.projectId }).replaceAll(
			'<',
			String.raw`\u003c`,
		);
		const hmrStatus = `import {createHotContext} from '/@vite/client'; const hot=createHotContext('/__worker_ide_status'); const report=status=>parent.postMessage({type:'__hmr-status',status},window.__PREVIEW_CONFIG.ideOrigin); report('connected'); hot.on('vite:beforeUpdate',()=>report('updating')); hot.on('vite:afterUpdate',()=>report('updated')); hot.on('vite:error',()=>report('error'));`;
		const scripts = `<script>window.__PREVIEW_CONFIG=${configuration}</script>${bridgeScripts.map((filename) => `<script src="${filename}"></script>`).join('')}<script type="module">${hmrStatus}</script>`;
		const headers = new Headers(response.headers);
		headers.delete('Content-Length');
		return finalizePreviewResponse(
			new Response(html.includes('<head>') ? html.replace('<head>', `<head>${scripts}`) : scripts + html, {
				status: response.status,
				headers,
			}),
			{ ideOrigin: context.ideOrigin },
		);
	}
}

export const containerVinextRuntime: ContainerFrameworkRuntime = new ContainerViteRuntime('vinext');
export const containerViteRuntime: ContainerFrameworkRuntime = new ContainerViteRuntime('spa');
