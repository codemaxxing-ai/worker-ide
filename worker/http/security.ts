import { env } from 'cloudflare:workers';

import { type ResponseMiddleware } from '../index';
import { getDomainConfiguration } from '../lib/domain-configuration';

import type { AuthedEnvironment } from '../types';
import type { MiddlewareHandler } from 'hono';

const PREVIEW_ROBOTS_HEADER_VALUE = 'noindex, nofollow';
export const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function withUpdatedHeaders(response: Response, headers: Record<string, string>): Response {
	if (response.status === 101) {
		return response;
	}

	const nextHeaders = new Headers(response.headers);
	for (const [name, value] of Object.entries(headers)) {
		nextHeaders.set(name, value);
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: nextHeaders,
	});
}

function applyAppSecurityHeaders(response: Response, contentOrigin: string): Response {
	return withUpdatedHeaders(response, {
		'Content-Security-Policy': `frame-ancestors 'self'; frame-src 'self' blob: https://*.${new URL(contentOrigin).host}`,
		'X-Frame-Options': 'SAMEORIGIN',
		'X-Content-Type-Options': 'nosniff',
		'Origin-Agent-Cluster': '?1',
		'Permissions-Policy': 'document-domain=()',
	});
}

export function applyPreviewRobotsHeader(response: Response): Response {
	return withUpdatedHeaders(response, {
		'X-Robots-Tag': PREVIEW_ROBOTS_HEADER_VALUE,
	});
}

export async function appSecurityHeadersMiddleware(_request: Request, next: () => Promise<Response>): Promise<Response> {
	const { contentOrigin } = getDomainConfiguration(env);
	return applyAppSecurityHeaders(await next(), contentOrigin);
}

export function composeResponseMiddleware(
	request: Request,
	handler: () => Promise<Response>,
	middlewares: ResponseMiddleware[],
): Promise<Response> {
	let next = handler;
	for (const middleware of middlewares.toReversed()) {
		const currentNext = next;
		next = () => middleware(request, currentNext);
	}
	return next();
}

export function hasValidWebSocketOrigin(request: Request, expectedOrigin: string): boolean {
	return request.headers.get('Origin') === expectedOrigin;
}

export function hasValidAppRequestOrigin(request: Request, expectedOrigin: string): boolean {
	const origin = request.headers.get('Origin');
	if (origin) {
		return origin === expectedOrigin;
	}

	const referer = request.headers.get('Referer');
	if (!referer) {
		return true;
	}

	try {
		return new URL(referer).origin === expectedOrigin;
	} catch {
		return false;
	}
}

export const requireSameOriginUnsafeMethods: MiddlewareHandler<AuthedEnvironment> = async (c, next) => {
	if (!UNSAFE_METHODS.has(c.req.method)) {
		await next();
		return;
	}

	const appOrigin = getDomainConfiguration(c.env).appOrigin;
	if (!hasValidAppRequestOrigin(c.req.raw, appOrigin)) {
		return c.json({ error: 'Forbidden' }, 403);
	}

	await next();
};
