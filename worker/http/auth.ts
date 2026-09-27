import { getCookies } from 'better-auth/cookies';
import { and, eq, gt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { serialize, serializeSigned } from 'hono/utils/cookie';
import { z } from 'zod';

import { buildAppOrigin, parseHost } from '@shared/domain';

import * as authSchema from '../db/auth-schema';
import { createAuth } from '../lib/auth';

import type { AuthedEnvironment } from '../types';

export function registerAuthRoutes(app: Hono<AuthedEnvironment>): void {
	const exchangeCodeSchema = z
		.string()
		.min(1)
		.max(256)
		.regex(/^[\w-]+$/);

	app.get('/api/auth/session/exchange', async (c) => {
		const codeResult = exchangeCodeSchema.safeParse(c.req.query('code'));
		if (!codeResult.success) return c.redirect('/');

		const code = codeResult.data;
		const database = drizzle(c.env.DB, { schema: authSchema });
		const now = new Date();
		const identifier = `session-exchange:${code}`;
		const [row] = await database
			.delete(authSchema.verification)
			.where(and(eq(authSchema.verification.identifier, identifier), gt(authSchema.verification.expiresAt, now)))
			.returning({ value: authSchema.verification.value });

		if (!row) return c.redirect('/');

		const url = new URL(c.req.url);
		const baseUrl = buildAppOrigin(parseHost(url.host).baseDomain, url.protocol);
		const { sessionToken, sessionData, dontRememberToken } = getCookies({ baseURL: baseUrl, secret: c.env.BETTER_AUTH_SECRET });

		const setSessionCookie = await serializeSigned(sessionToken.name, row.value, c.env.BETTER_AUTH_SECRET, sessionToken.attributes);
		const expireDataCookie = serialize(sessionData.name, '', { ...sessionData.attributes, maxAge: 0 });

		const setDontRememberCookie = await serializeSigned(
			dontRememberToken.name,
			'true',
			c.env.BETTER_AUTH_SECRET,
			dontRememberToken.attributes,
		);

		const headers = new Headers();
		headers.set('Location', '/');
		headers.append('Set-Cookie', setSessionCookie);
		headers.append('Set-Cookie', expireDataCookie);
		headers.append('Set-Cookie', setDontRememberCookie);

		return new Response(undefined, { status: 302, headers });
	});

	// Disable better-auth admin plugin HTTP endpoints
	app.all('/api/auth/admin/*', (c) => c.notFound());

	app.on(['GET', 'POST'], '/api/auth/*', async (c) => {
		const url = new URL(c.req.url);
		const baseUrl = buildAppOrigin(parseHost(url.host).baseDomain, url.protocol);
		const auth = createAuth(
			{
				DB: c.env.DB,
				BETTER_AUTH_SECRET: c.env.BETTER_AUTH_SECRET,
				GITHUB_CLIENT_ID: c.env.GITHUB_CLIENT_ID,
				GITHUB_CLIENT_SECRET: c.env.GITHUB_CLIENT_SECRET,
				GOOGLE_CLIENT_ID: c.env.GOOGLE_CLIENT_ID,
				GOOGLE_CLIENT_SECRET: c.env.GOOGLE_CLIENT_SECRET,
			},
			baseUrl,
			c.req.raw,
		);
		return auth.handler(c.req.raw);
	});
}
