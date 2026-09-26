import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { buildAppOrigin, parseHost } from '@shared/domain';

import { registerAuthRoutes } from './auth';
import { registerDevelopmentAuthRoutes, registerDevelopmentTestRoutes } from './development';
import { registerPreviewAccessRoutes } from './preview-access';
import { projectApp } from './project-app';
import { requireSameOriginUnsafeMethods } from './security';
import { analyticsMiddleware } from '../lib/analytics-middleware';
import { requireAuth } from '../lib/auth-middleware';
import { requireRateLimit } from '../lib/rate-limit-middleware';
import { cloudflareOAuthRoutes } from '../routes/cloudflare-oauth-routes';
import { orgRoutes } from '../routes/org-routes';
import { publicRootRoutes, protectedRootRoutes } from '../routes/root-routes';
import { transferRoutes } from '../routes/transfer-routes';
import { userRoutes } from '../routes/user-routes';

import type { AuthedEnvironment } from '../types';
import type { MiddlewareHandler } from 'hono';

const AUTHENTICATED_API_ROUTE_PATTERNS = ['/api/*', '/p/*/api/*'];
const AUTHENTICATED_NON_API_ROUTE_PATTERNS = ['/p/*/__agent', '/p/*/__agent/*', '/p/*/__ws', '/p/*/__ws/*'];

function registerMiddleware(
	appInstance: Hono<AuthedEnvironment>,
	routePatterns: string[],
	middleware: MiddlewareHandler<AuthedEnvironment>,
) {
	for (const routePattern of routePatterns) {
		appInstance.use(routePattern, middleware);
	}
}

function registerProtectedApiMiddleware(appInstance: Hono<AuthedEnvironment>, middleware: MiddlewareHandler<AuthedEnvironment>) {
	registerMiddleware(appInstance, AUTHENTICATED_API_ROUTE_PATTERNS, middleware);
}

export const app = new Hono<AuthedEnvironment>();

app.use(
	'/api/*',
	cors({
		origin: (origin, c) => {
			const { baseDomain } = parseHost(new URL(c.req.url).host);
			const appOrigin = buildAppOrigin(baseDomain, new URL(c.req.url).protocol);
			return origin === appOrigin ? origin : undefined;
		},
		credentials: true,
	}),
);
app.use(
	'/p/*/api/*',
	cors({
		origin: (origin, c) => {
			const { baseDomain } = parseHost(new URL(c.req.url).host);
			const appOrigin = buildAppOrigin(baseDomain, new URL(c.req.url).protocol);
			return origin === appOrigin ? origin : undefined;
		},
		credentials: true,
	}),
);

registerProtectedApiMiddleware(app, requireSameOriginUnsafeMethods);

app.route('/api', publicRootRoutes);

// In dev mode, better-auth's internal loopback HTTP calls crash inside
// miniflare, so resolve the session endpoint directly from D1 instead.

registerDevelopmentAuthRoutes(app);

registerAuthRoutes(app);

registerPreviewAccessRoutes(app);

// Dev-only E2E helper for seeding a local test user, org, and session.

registerDevelopmentTestRoutes(app);

registerProtectedApiMiddleware(app, requireAuth);
registerMiddleware(app, AUTHENTICATED_NON_API_ROUTE_PATTERNS, requireAuth);

// Register analytics after auth so rejected requests are never recorded.

registerProtectedApiMiddleware(app, analyticsMiddleware);

registerProtectedApiMiddleware(app, requireRateLimit);

app.route('/api', orgRoutes);
app.route('/api', userRoutes);
app.route('/api', transferRoutes);
app.route('/api', cloudflareOAuthRoutes);

app.route('/api', protectedRootRoutes);

// Project-scoped API / WebSocket / preview routes. This app is mounted once so
// Hono compiles the project route tree at startup rather than once per request.
app.route('/p/:projectId', projectApp);

app.get('/p/:projectId', async (c) => {
	return env.ASSETS.fetch(c.req.raw);
});

// Fallback to static assets
app.all('*', (c) => {
	return env.ASSETS.fetch(c.req.raw);
});
