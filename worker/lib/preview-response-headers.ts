/** Platform policy is applied after user code, for both preview runtimes. */
export const PREVIEW_ROBOTS_HEADER_VALUE = 'noindex, nofollow';
export const STRIPPED_PREVIEW_HEADERS = [
	'Service-Worker-Allowed',
	'Service-Worker-Navigation-Preload',
	'Clear-Site-Data',
	'Content-Security-Policy-Report-Only',
	'X-Frame-Options',
	'Cross-Origin-Embedder-Policy',
	'Access-Control-Allow-Origin',
	'Access-Control-Allow-Credentials',
	'Access-Control-Allow-Private-Network',
	'Access-Control-Allow-Headers',
	'Access-Control-Allow-Methods',
	'Access-Control-Expose-Headers',
	'Access-Control-Max-Age',
	'CDN-Cache-Control',
	'Cloudflare-CDN-Cache-Control',
	'Surrogate-Control',
];
export interface PreviewResponseContext {
	ideOrigin: string;
	allowPlatformCookies?: boolean;
}

function previewCsp(ideOrigin: string): string {
	return [
		"script-src 'self' 'unsafe-inline' 'unsafe-eval' https: blob:",
		"style-src 'self' 'unsafe-inline' https:",
		"img-src 'self' https: data: blob:",
		"media-src 'self' https: data: blob:",
		"font-src 'self' https: data:",
		"connect-src 'self' https: wss:",
		"worker-src 'self' blob:",
		"frame-src 'none'",
		`frame-ancestors ${ideOrigin}`,
		"object-src 'none'",
		"form-action 'self'",
		"base-uri 'self'",
	].join('; ');
}
function applyPreviewSecurityHeaders(headers: Headers, response: Response, context: PreviewResponseContext): void {
	const isHtml = response.headers.get('Content-Type')?.toLowerCase().includes('text/html');
	headers.set('Content-Security-Policy', previewCsp(context.ideOrigin));
	headers.set('Referrer-Policy', 'no-referrer');
	headers.set('X-Content-Type-Options', 'nosniff');
	headers.set('Origin-Agent-Cluster', '?1');
	headers.set('Permissions-Policy', 'document-domain=()');
	headers.set('Cross-Origin-Opener-Policy', 'same-origin');
	if (isHtml) {
		headers.delete('Cross-Origin-Resource-Policy');
	} else {
		headers.set('Cross-Origin-Resource-Policy', 'same-origin');
	}
	// Browser-private responses must never be cached outside the authorization boundary.
	headers.set('Cache-Control', 'no-store');
}
function applyPreviewRobotsHeader(headers: Headers): void {
	headers.set('X-Robots-Tag', PREVIEW_ROBOTS_HEADER_VALUE);
}
/** Only the reserved grant-redemption handler may preserve a platform cookie. */
export function finalizePreviewResponse(response: Response, context: PreviewResponseContext): Response {
	if (response.status === 101) return response;
	const headers = new Headers(response.headers);
	for (const name of STRIPPED_PREVIEW_HEADERS) headers.delete(name);
	if (!context.allowPlatformCookies) headers.delete('Set-Cookie');
	applyPreviewSecurityHeaders(headers, response, context);
	applyPreviewRobotsHeader(headers);
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
