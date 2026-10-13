import { hc } from 'hono/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BASE_URL, cleanupProjects, createdProjectIds, ensureTestSession, TEST_ORGANIZATION_ID } from './helpers';
import { localFetch } from '../local-https';

import type { ApiRoutes, RootApiRoutes } from '../../worker/routes';

interface HostedProject {
	projectId: string;
	origin: string;
}

describe('live hosted content boundary', () => {
	let cookie: string;
	let projects: HostedProject[];
	function api(projectId: string) {
		return hc<ApiRoutes>(`${BASE_URL}/p/${projectId}/api`, { fetch: localFetch, headers: { Cookie: cookie } });
	}
	beforeAll(async () => {
		cookie = await ensureTestSession();
		const root = hc<RootApiRoutes>(`${BASE_URL}/api`, { fetch: localFetch, headers: { Cookie: cookie } });
		projects = [];
		for (const template of ['request-inspector', 'vinext']) {
			const response = await root['new-project'].$post({ json: { template, organizationId: TEST_ORGANIZATION_ID } });
			if (!response.ok) throw new Error(`Project creation failed: ${response.status}`);
			const { projectId } = await response.json();
			createdProjectIds.push(projectId);
			const preview = await api(projectId)['preview-url'].$get({});
			if (!preview.ok) throw new Error('Preview URL unavailable');
			const { origin } = await preview.json();
			projects.push({ projectId, origin });
		}
	});
	afterAll(cleanupProjects);

	it('applies the same response policy to React SPA and vinext documents, assets and errors', async () => {
		for (const project of projects) {
			const response = await localFetch(`${project.origin}/`, { redirect: 'manual' });
			expect(response.status).toBe(200);
			expect(response.headers.get('Content-Type')).toContain('text/html');
			expect(response.headers.get('Content-Security-Policy')).toContain(`frame-ancestors ${new URL(BASE_URL).origin}`);
			expect(response.headers.get('Content-Security-Policy')).toContain("frame-src 'none'");
			expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
			expect(response.headers.get('Cache-Control')).toBe('no-store');
			expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
			expect(response.headers.get('Set-Cookie')).toBeNull();
			const denied = await localFetch(`${project.origin}/service-worker.js`, {
				headers: { 'Service-Worker': 'script' },
				redirect: 'manual',
			});
			expect(denied.status).toBe(403);
			expect(denied.headers.get('X-Content-Type-Options')).toBe('nosniff');
			expect(denied.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
		}
	});

	it('denies sibling requests and reserves platform authentication paths', async () => {
		const [first, second] = projects;
		for (const method of ['GET', 'POST', 'OPTIONS']) {
			const denied = await localFetch(`${first.origin}/api/inspect`, {
				method,
				headers: { Origin: second.origin, 'Sec-Fetch-Site': 'same-site' },
				redirect: 'manual',
			});
			expect(denied.status).toBe(403);
		}
		const reserved = await localFetch(`${first.origin}/__preview-auth/other`, { redirect: 'manual' });
		expect(reserved.status).toBe(404);
		const siblingBootstrap = new URL(`/p/${first.projectId}/__preview-auth/bootstrap`, BASE_URL);
		siblingBootstrap.searchParams.set('returnTo', second.origin);
		const bootstrap = await localFetch(siblingBootstrap, { headers: { Cookie: cookie }, redirect: 'manual' });
		expect(bootstrap.status).toBe(400);
	});

	it('binds redemption and cookies to one project and verifies cookie acceptance before loading content', async () => {
		const [first, second] = projects;
		for (const project of projects) {
			const visibility = await api(project.projectId).project.visibility.$put({ json: { visibility: 'private' } });
			expect(visibility.ok).toBe(true);
		}
		const preview = await api(first.projectId)['preview-url'].$get({});
		if (!preview.ok) throw new Error('Private preview URL unavailable');
		const { url, origin } = await preview.json();
		const stolenGrant = new URL(url);
		stolenGrant.host = new URL(second.origin).host;
		const rejectedGrant = await localFetch(stolenGrant, { redirect: 'manual' });
		expect(rejectedGrant.status).toBe(403);
		const redeemed = await localFetch(url, { redirect: 'manual' });
		expect(redeemed.status).toBe(302);
		const accessCookie = redeemed.headers.get('Set-Cookie');
		const check = redeemed.headers.get('Location');
		if (!accessCookie || !check) throw new Error('Expected access cookie and acceptance check');
		expect(accessCookie).toContain('Partitioned');
		expect(accessCookie).not.toContain('Domain=');
		const rejected = await localFetch(check, { redirect: 'manual' });
		expect(rejected.status).toBe(403);
		expect(await rejected.text()).toContain('__preview-access-blocked');
		const accepted = await localFetch(check, { headers: { Cookie: accessCookie.split(';')[0] }, redirect: 'manual' });
		expect(accepted.status).toBe(302);
		expect(accepted.headers.get('Location')).toBe(`${origin}/`);
		const stolenCookie = await localFetch(`${second.origin}/api/inspect`, {
			headers: { Cookie: accessCookie.split(';')[0] },
			redirect: 'manual',
		});
		expect(stolenCookie.status).toBe(403);
	});
});
