import { describe, expect, it } from 'vitest';

import { finalizePreviewResponse, STRIPPED_PREVIEW_HEADERS } from './preview-response-headers';

function finalize(response: Response, allowPlatformCookies = false): Response {
	return finalizePreviewResponse(response, { ideOrigin: 'https://codemaxxing.app', allowPlatformCookies });
}

describe('shared preview response boundary', () => {
	it.each(['text/html; charset=UTF-8', 'text/css', 'application/json', 'application/javascript', 'image/svg+xml'])(
		'enforces isolation for %s, including error responses',
		(contentType) => {
			const response = finalize(
				new Response('body', {
					status: 403,
					headers: {
						'Content-Type': contentType,
						'Cache-Control': 'public, max-age=999999',
						'Content-Security-Policy': '*',
						'Permissions-Policy': 'document-domain=*',
						'Cross-Origin-Embedder-Policy': 'require-corp',
					},
				}),
			);
			for (const [header, value] of Object.entries({
				'X-Content-Type-Options': 'nosniff',
				'Referrer-Policy': 'no-referrer',
				'X-Robots-Tag': 'noindex, nofollow',
				'Origin-Agent-Cluster': '?1',
				'Permissions-Policy': 'document-domain=()',
				'Cache-Control': 'no-store',
			}))
				expect(response.headers.get(header)).toBe(value);
			expect(response.headers.get('Content-Security-Policy')).toContain('frame-ancestors https://codemaxxing.app');
			expect(response.headers.get('Cross-Origin-Embedder-Policy')).toBeNull();
			expect(response.status).toBe(403);
			if (contentType.startsWith('text/html')) {
				expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
				expect(response.headers.get('Cross-Origin-Resource-Policy')).toBeNull();
				for (const directive of [
					"frame-src 'none'",
					"object-src 'none'",
					"base-uri 'self'",
					"form-action 'self'",
					"worker-src 'self' blob:",
					"'unsafe-inline' 'unsafe-eval' https:",
					"connect-src 'self' https: wss:",
				])
					expect(response.headers.get('Content-Security-Policy')).toContain(directive);
			} else expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
		},
	);

	it('strips generated cookies, CORS grants and platform-header overrides', () => {
		const headers = new Headers({ 'Set-Cookie': 'stolen=credential', 'X-Keep': 'yes' });
		for (const name of STRIPPED_PREVIEW_HEADERS) headers.set(name, '*');
		const response = finalize(new Response('ok', { headers }));
		for (const name of STRIPPED_PREVIEW_HEADERS) expect(response.headers.get(name)).toBeNull();
		expect(response.headers.get('Set-Cookie')).toBeNull();
		expect(response.headers.get('X-Keep')).toBe('yes');
	});

	it('allows cookies only for a platform authentication response', () => {
		const response = finalize(
			new Response(undefined, {
				status: 302,
				headers: { 'Set-Cookie': '__Host-worker-ide-preview-access=grant', Location: '/__preview-auth/check' },
			}),
			true,
		);
		expect(response.headers.get('Set-Cookie')).toContain('__Host-worker-ide-preview-access=grant');
		expect(response.headers.get('Cache-Control')).toBe('no-store');
	});

	it('preserves a real WebSocket upgrade', () => {
		const pair = new WebSocketPair();
		pair[1].accept();
		const upgrade = new Response(undefined, { status: 101, webSocket: pair[0] });
		expect(finalize(upgrade)).toBe(upgrade);
		pair[1].close();
	});
});
