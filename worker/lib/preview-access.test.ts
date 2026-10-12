import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	buildPreviewAccessBootstrapUrl,
	buildPreviewAccessLoginUrl,
	buildPreviewRedeemUrl,
	createPreviewAccessCookieToken,
	createPreviewAccessGrant,
	getRedirectPath,
	isNavigationRequest,
	readPreviewAccessCookie,
	readPreviewAccessGrant,
	serializePreviewAccessCookie,
} from './preview-access';

const secret = 'preview-secret';
const identity = {
	projectId: 'project123',
	previewToken: 'abcdef123456',
	previewOrigin: 'https://project123-abcdef123456.codemaxxing.net',
	organizationId: 'org-1',
	userId: 'user-1',
};
afterEach(() => vi.restoreAllMocks());

describe('preview access', () => {
	it('binds a grant to an exact origin, project and organization and keeps the 60-second lifetime', async () => {
		const now = Date.now();
		vi.spyOn(Date, 'now').mockReturnValue(now);
		const grant = await createPreviewAccessGrant({ ...identity, redirectPath: '/nested/path?query=1' }, secret);
		expect(await readPreviewAccessGrant(grant, secret)).toEqual({
			...identity,
			redirectPath: '/nested/path?query=1',
			expiresAt: now + 60_000,
		});
		expect(await readPreviewAccessGrant(grant, 'wrong-secret')).toBeUndefined();
		vi.spyOn(Date, 'now').mockReturnValue(now + 60_000);
		expect(await readPreviewAccessGrant(grant, secret)).toBeUndefined();
	});

	it('rejects cookies from another project, token, origin, organization or purpose', async () => {
		const cookie = await createPreviewAccessCookieToken(identity, secret);
		const headers = new Headers({ Cookie: `__Host-worker-ide-preview-access=${cookie}` });
		const origin = new URL(identity.previewOrigin);
		expect(
			await readPreviewAccessCookie(headers, secret, identity.projectId, identity.previewToken, origin, identity.organizationId),
		).toMatchObject(identity);
		for (const [projectId, token, url, organizationId] of [
			['other', identity.previewToken, identity.previewOrigin, identity.organizationId],
			[identity.projectId, 'other', identity.previewOrigin, identity.organizationId],
			[identity.projectId, identity.previewToken, 'https://sibling.codemaxxing.net', identity.organizationId],
			[identity.projectId, identity.previewToken, identity.previewOrigin, 'other'],
		]) {
			expect(await readPreviewAccessCookie(headers, secret, projectId, token, new URL(url), organizationId)).toBeUndefined();
		}
		const grant = await createPreviewAccessGrant({ ...identity, redirectPath: '/' }, secret);
		expect(
			await readPreviewAccessCookie(
				new Headers({ Cookie: `__Host-worker-ide-preview-access=${grant}` }),
				secret,
				identity.projectId,
				identity.previewToken,
				origin,
				identity.organizationId,
			),
		).toBeUndefined();
		expect(await readPreviewAccessGrant(cookie, secret)).toBeUndefined();
	});

	it('expires cookies after 55 minutes and rejects malformed input', async () => {
		const now = Date.now();
		vi.spyOn(Date, 'now').mockReturnValue(now);
		const cookie = await createPreviewAccessCookieToken(identity, secret);
		vi.spyOn(Date, 'now').mockReturnValue(now + 55 * 60_000);
		for (const value of [cookie, '%invalid', 'invalid.signature']) {
			expect(
				await readPreviewAccessCookie(
					new Headers({ Cookie: `__Host-worker-ide-preview-access=${value}` }),
					secret,
					identity.projectId,
					identity.previewToken,
					new URL(identity.previewOrigin),
					identity.organizationId,
				),
			).toBeUndefined();
		}
	});

	it('issues one host-only CHIPS cookie', () => {
		const cookie = serializePreviewAccessCookie('token');
		expect(cookie).toContain('__Host-worker-ide-preview-access=token');
		for (const attribute of ['Secure', 'HttpOnly', 'Path=/', 'SameSite=None', 'Partitioned', 'Max-Age=3300'])
			expect(cookie).toContain(attribute);
		expect(cookie).not.toContain('Domain=');
	});

	it('reserves authentication paths and builds explicit bootstrap and redemption URLs', () => {
		const bootstrap = new URL(buildPreviewAccessBootstrapUrl('https://codemaxxing.app', identity.projectId, identity.previewOrigin));
		expect(bootstrap.pathname).toBe(`/p/${identity.projectId}/__preview-auth/bootstrap`);
		expect(new URL(buildPreviewAccessLoginUrl('https://codemaxxing.app', bootstrap.href)).searchParams.get('next')).toBe(bootstrap.href);
		expect(new URL(buildPreviewRedeemUrl(identity.previewOrigin, 'grant')).pathname).toBe('/__preview-auth/redeem');
		expect(getRedirectPath(new URL('/__preview-auth/check?path=/api', identity.previewOrigin))).toBe('/');
		expect(getRedirectPath(new URL('/path?query=1', identity.previewOrigin))).toBe('/path?query=1');
		expect(isNavigationRequest(new Request(identity.previewOrigin, { headers: { 'Sec-Fetch-Dest': 'iframe' } }))).toBe(true);
		expect(isNavigationRequest(new Request(identity.previewOrigin, { method: 'POST' }))).toBe(false);
	});
});
