import { WorkerEntrypoint } from 'cloudflare:workers';

import { assertSafeExternalUrl } from '../services/agent/tools/network-policy';

import type { RequestOriginContext } from '../services/agent/request-origin-context';

export class ComputerEgress extends WorkerEntrypoint<Env, { projectObjectId: string }> {
	async fetch(request: Request): Promise<Response> {
		try {
			const project = this.env.DurableObjectFilesystem.get(this.env.DurableObjectFilesystem.idFromString(this.ctx.props.projectObjectId));
			using origin = await project.getComputerRequestOrigin();
			if (!origin) throw new Error('Register a project request origin before using container networking');
			const context: RequestOriginContext = { baseDomain: origin.baseDomain, protocol: origin.protocol };
			assertSafeExternalUrl(new URL(request.url), context);
			const headers = new Headers(request.headers);
			for (const name of ['authorization', 'cookie', 'proxy-authorization']) headers.delete(name);
			return await fetch(new Request(request, { headers, redirect: 'manual' }));
		} catch (error) {
			return new Response(error instanceof Error ? error.message : 'Blocked outbound request', { status: 403 });
		}
	}
}
