import { createMiddleware } from 'hono/factory';

import { createAuth } from './auth';
import { getDomainConfiguration } from './domain-configuration';

import type { AuthedEnvironment } from '../types';
export const requireAuth = createMiddleware<AuthedEnvironment>(async (context, next) => {
	// ---------------------------------------------------------------------------
	// Dev-only fast path: validate the session token directly via D1.
	// This avoids better-auth's internal loopback HTTP call which crashes
	// in the miniflare/Vite dev environment.
	// Dead-code-eliminated from production builds by Vite.
	// ---------------------------------------------------------------------------
	if (import.meta.env.DEV) {
		const { resolveDevelopmentSession } = await import('./development-session');
		const result = await resolveDevelopmentSession(context.env.DB, context.req.raw.headers);
		if (!result) {
			return context.json({ error: 'Unauthorized' }, 401);
		}

		const collaborationVisible = typeof result.session.impersonatedBy !== 'string' || result.session.impersonatedBy.length === 0;

		context.set('session', {
			id: result.session.id,
			userId: result.session.userId,
			updateActivity: collaborationVisible,
			collaborationVisible,
		});
		await next();
		return;
	}

	// ---------------------------------------------------------------------------
	// Production path: use better-auth's full session validation.
	// ---------------------------------------------------------------------------
	const baseUrl = getDomainConfiguration(context.env).appOrigin;

	const auth = createAuth(
		{
			DB: context.env.DB,
			BETTER_AUTH_SECRET: context.env.BETTER_AUTH_SECRET,
			GITHUB_CLIENT_ID: context.env.GITHUB_CLIENT_ID,
			GITHUB_CLIENT_SECRET: context.env.GITHUB_CLIENT_SECRET,
			GOOGLE_CLIENT_ID: context.env.GOOGLE_CLIENT_ID,
			GOOGLE_CLIENT_SECRET: context.env.GOOGLE_CLIENT_SECRET,
		},
		baseUrl,
	);

	const session = await auth.api.getSession({ headers: context.req.raw.headers });

	if (!session) {
		return context.json({ error: 'Unauthorized' }, 401);
	}

	const impersonatedBy = 'impersonatedBy' in session.session ? session.session.impersonatedBy : undefined;
	const collaborationVisible = typeof impersonatedBy !== 'string' || impersonatedBy.length === 0;

	context.set('session', {
		id: session.session.id,
		userId: session.user.id,
		updateActivity: collaborationVisible,
		collaborationVisible,
	});

	await next();
});
