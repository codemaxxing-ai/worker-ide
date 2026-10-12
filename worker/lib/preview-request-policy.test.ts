import { describe, expect, it } from 'vitest';

import { isForbiddenPreviewRequest as forbidden } from './preview-request-policy';

function isForbiddenPreviewRequest(request: Request): boolean {
	return forbidden(request, 'https://codemaxxing.app');
}

const origin = 'https://project-a.codemaxxing.net';
function request(headers: Record<string, string>, method = 'GET'): Request {
	return new Request(`${origin}/api`, { headers, method });
}

describe('preview browser request boundary', () => {
	it('allows same-origin requests, editor iframe navigation and standalone navigation', () => {
		expect(isForbiddenPreviewRequest(request({ Origin: origin, 'Sec-Fetch-Site': 'same-origin' }, 'POST'))).toBe(false);
		expect(
			isForbiddenPreviewRequest(request({ 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Mode': 'navigate' })),
		).toBe(false);
		expect(isForbiddenPreviewRequest(request({ 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Dest': 'document' }))).toBe(false);
		expect(isForbiddenPreviewRequest(request({ Origin: 'https://codemaxxing.app', 'Sec-Fetch-Dest': 'iframe' }))).toBe(false);
		expect(isForbiddenPreviewRequest(request({ Origin: 'https://project-b.codemaxxing.net', 'Sec-Fetch-Dest': 'iframe' }))).toBe(true);
	});
	it.each(['same-site', 'cross-site'])('blocks sibling and external requests classified as %s before handlers run', (site) => {
		for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
			expect(isForbiddenPreviewRequest(request({ Origin: 'https://project-b.codemaxxing.net', 'Sec-Fetch-Site': site }, method))).toBe(
				true,
			);
		}
		expect(isForbiddenPreviewRequest(request({ 'Sec-Fetch-Site': site, 'Sec-Fetch-Dest': 'script' }))).toBe(true);
		expect(isForbiddenPreviewRequest(request({ 'Sec-Fetch-Site': site, 'Sec-Fetch-Dest': 'image' }))).toBe(true);
		expect(isForbiddenPreviewRequest(request({ Origin: 'https://project-b.codemaxxing.net', Upgrade: 'websocket' }))).toBe(true);
	});
	it('blocks service workers but preserves ordinary workers', () => {
		expect(isForbiddenPreviewRequest(request({ 'Service-Worker': 'script' }))).toBe(true);
		expect(isForbiddenPreviewRequest(request({ 'Sec-Fetch-Dest': 'serviceworker' }))).toBe(true);
		expect(isForbiddenPreviewRequest(request({ 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'worker' }))).toBe(false);
	});
});
