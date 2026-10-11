import { createExecutionContext, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ComputerEgress } from './computer-egress';

afterEach(() => vi.unstubAllGlobals());

describe('Computer container gateway', () => {
	it('blocks private and deployment hosts and forwards public requests with manual redirects', async () => {
		const identifier = env.DurableObjectFilesystem.idFromName(crypto.randomUUID());
		await env.DurableObjectFilesystem.get(identifier).registerComputerSession('session', 'code', {
			baseDomain: 'ide.example.com',
			protocol: 'https:',
		});
		const context = Object.assign(createExecutionContext(), { props: { projectObjectId: identifier.toString() } });
		const gateway = new ComputerEgress(context, env);
		const external = vi.fn(async (_request: Request) => new Response('package', { status: 200 }));
		vi.stubGlobal('fetch', external);
		for (const url of ['http://127.0.0.1/', 'http://10.0.0.1/', 'http://localhost/', 'https://ide.example.com/api/']) {
			const response = await gateway.fetch(new Request(url));
			expect(response.status).toBe(403);
		}
		expect(external).not.toHaveBeenCalled();
		const response = await gateway.fetch(
			new Request('https://registry.npmjs.org/is-number', {
				headers: { Authorization: 'private', Cookie: 'private', 'Proxy-Authorization': 'private', Accept: 'application/json' },
			}),
		);
		expect(response.status).toBe(200);
		const call = external.mock.calls[0];
		expect(call).toBeDefined();
		const forwarded: unknown = call?.[0];
		if (!(forwarded instanceof Request)) throw new Error('Expected forwarded request');
		expect(forwarded.redirect).toBe('manual');
		expect(forwarded.headers.has('authorization')).toBe(false);
		expect(forwarded.headers.has('cookie')).toBe(false);
		expect(forwarded.headers.has('proxy-authorization')).toBe(false);
		expect(forwarded.headers.get('accept')).toBe('application/json');
	});
});
