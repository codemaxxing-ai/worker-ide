import { makeSignature } from 'better-auth/crypto';
import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { beforeAll, expect, it, vi } from 'vitest';

import { createAuth } from './auth';
import { account, session, user } from '../db/auth-schema';
import migration from '../migrations/d1-auth/0024_session-authentication.sql?raw';

const database = drizzle(env.DB);
const day = 24 * 60 * 60 * 1000;
const baseURL = 'https://worker-ide.example.test';
const environment = {
	DB: env.DB,
	BETTER_AUTH_SECRET: 'test-only-session-secret-8e987c5217a946b0',
	GOOGLE_CLIENT_ID: 'test-google',
	GOOGLE_CLIENT_SECRET: 'test-secret',
	GITHUB_CLIENT_ID: 'test-github',
	GITHUB_CLIENT_SECRET: 'test-secret',
};

beforeAll(async () => {
	await env.DB.exec(
		`CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, email_verified INTEGER NOT NULL DEFAULT 0, image TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, banned_at INTEGER, role TEXT NOT NULL DEFAULT 'user', banned INTEGER DEFAULT 0, ban_reason TEXT, ban_expires INTEGER)`,
	);
	await env.DB.exec(
		`CREATE TABLE "session" (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, token TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ip_address TEXT, user_agent TEXT, user_id TEXT NOT NULL, active_organization_id TEXT, impersonated_by TEXT)`,
	);
	await env.DB.exec(migration);
	await env.DB.exec(
		`CREATE TABLE "account" (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, provider_id TEXT NOT NULL, user_id TEXT NOT NULL, access_token TEXT, refresh_token TEXT, id_token TEXT, access_token_expires_at INTEGER, refresh_token_expires_at INTEGER, scope TEXT, password TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
	);
	await env.DB.exec(
		`CREATE TABLE "verification" (id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER, updated_at INTEGER)`,
	);
});

async function seed(providerId: 'google' | 'github' = 'github') {
	const userId = crypto.randomUUID();
	const sessionId = crypto.randomUUID();
	const token = crypto.randomUUID();
	const accountId = crypto.randomUUID();
	const createdAt = new Date(Math.floor((Date.now() - 3 * day) / 1000) * 1000);
	await database.batch([
		database
			.insert(user)
			.values({ id: userId, name: 'Tester', email: `${userId}@example.test`, emailVerified: true, createdAt, updatedAt: createdAt }),
		database.insert(session).values({
			id: sessionId,
			userId,
			token,
			createdAt,
			updatedAt: createdAt,
			expiresAt: new Date(Date.now() + 4 * day),
			ipAddress: '192.0.2.1',
			userAgent: 'Test browser',
		}),
		database.insert(account).values({ id: crypto.randomUUID(), userId, providerId, accountId, createdAt, updatedAt: createdAt }),
	]);
	const cookie = `__Secure-better-auth.session_token=${encodeURIComponent(`${token}.${await makeSignature(token, environment.BETTER_AUTH_SECRET)}`)}`;
	return { userId, id: sessionId, token, accountId, createdAt, cookie, providerId };
}

async function startVerification(
	current: Awaited<ReturnType<typeof seed>>,
	additionalData?: Record<string, unknown>,
	endpoint = 'link-social',
) {
	const auth = createAuth(environment, baseURL);
	const context = await auth.$context;
	const provider = context.socialProviders.find((entry) => entry.id === current.providerId);
	if (!provider) throw new Error('Missing test provider');
	vi.spyOn(provider, 'validateAuthorizationCode').mockResolvedValue({ accessToken: 'test-access-token' });
	const identity = vi.spyOn(provider, 'getUserInfo').mockResolvedValue({
		user: { id: current.accountId, name: 'Tester', email: `${current.userId}@example.test`, emailVerified: true },
		data: { id: current.accountId, sub: current.accountId },
	});
	const response = await auth.handler(
		new Request(`${baseURL}/api/auth/${endpoint}`, {
			method: 'POST',
			headers: { cookie: current.cookie, origin: baseURL, 'content-type': 'application/json' },
			body: JSON.stringify({
				provider: current.providerId,
				callbackURL: '/settings/account',
				additionalData: additionalData ?? { intent: 'reauthenticate' },
			}),
		}),
	);
	expect(response.status).toBe(200);
	const body: { url: string } = await response.json();
	const state = new URL(body.url).searchParams.get('state');
	const cookie = [current.cookie, ...response.headers.getSetCookie().map((entry) => entry.split(';')[0])].join('; ');
	const callback = (callbackCookie = cookie, query = `code=test-code&state=${state}`) =>
		auth.handler(new Request(`${baseURL}/api/auth/callback/${current.providerId}?${query}`, { headers: { cookie: callbackCookie } }));
	return { auth, callback, identity, cookie, state };
}

async function callbackLocation(flow: Awaited<ReturnType<typeof startVerification>>) {
	const response = await flow.callback();
	return response.headers.get('location');
}

it.each(['google', 'github'])('verifies %s without replacing the session or linking an account', async (provider) => {
	const current = await seed(provider === 'google' ? 'google' : 'github');
	const flow = await startVerification(current);
	expect(await callbackLocation(flow)).toContain('/settings/account?reauth=success');
	const rows = await database.select().from(session).where(eq(session.userId, current.userId));
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		id: current.id,
		token: current.token,
		createdAt: current.createdAt,
		ipAddress: '192.0.2.1',
		userAgent: 'Test browser',
	});
	expect(rows[0].authenticatedAt?.getTime()).toBeGreaterThan(Date.now() - 10_000);
	expect(await database.select().from(account).where(eq(account.userId, current.userId))).toHaveLength(1);
	expect(await callbackLocation(flow)).not.toContain('reauth=success');
});

it('ordinary GitHub sign-in still creates a new session without refreshing the original', async () => {
	const current = await seed();
	const flow = await startVerification(current, {}, 'sign-in/social');
	expect(await callbackLocation(flow)).toContain('/settings/account');
	const rows = await database.select().from(session).where(eq(session.userId, current.userId));
	expect(rows).toHaveLength(2);
	expect(rows.find((row) => row.id === current.id)).toMatchObject({ token: current.token, createdAt: current.createdAt });
	expect(rows.find((row) => row.id === current.id)?.authenticatedAt).toBeFalsy();
});

it('rejects a different GitHub identity before any account write', async () => {
	const current = await seed();
	const flow = await startVerification(current);
	flow.identity.mockResolvedValue({
		user: { id: 'wrong-account', name: 'Other', email: 'other@example.test', emailVerified: true },
		data: { id: 'wrong-account' },
	});
	expect(await callbackLocation(flow)).toContain('reauth=error');
	expect(await database.select().from(account).where(eq(account.userId, current.userId))).toHaveLength(1);
	const [unchanged] = await database.select().from(session).where(eq(session.id, current.id));
	expect(unchanged.authenticatedAt).toBeFalsy();
});

it.each(['signed-out', 'revoked', 'expired', 'expired-session', 'unlinked', 'other-browser', 'other-session', 'cancelled'])(
	'rejects %s verification',
	async (failure) => {
		const current = await seed();
		const flow = await startVerification(current);
		let cookie = flow.cookie;
		if (failure === 'signed-out')
			cookie = cookie
				.split('; ')
				.filter((entry) => !entry.startsWith('__Secure-better-auth.session_token='))
				.join('; ');
		if (failure === 'revoked') await database.delete(session).where(eq(session.id, current.id));
		if (failure === 'expired-session')
			await database
				.update(session)
				.set({ expiresAt: new Date(Date.now() - 1000) })
				.where(eq(session.id, current.id));
		if (failure === 'unlinked') await database.delete(account).where(eq(account.userId, current.userId));
		if (failure === 'expired')
			await env.DB.prepare("UPDATE verification SET expires_at = ? WHERE identifier LIKE 'reauthentication:%'")
				.bind(Math.floor(Date.now() / 1000) - 1)
				.run();
		if (failure === 'other-browser' || failure === 'other-session') {
			const otherBrowser = await seed();
			if (failure === 'other-session')
				await database.update(session).set({ userId: current.userId }).where(eq(session.id, otherBrowser.id));
			cookie = `${otherBrowser.cookie}; ${cookie
				.split('; ')
				.filter((entry) => !entry.startsWith('__Secure-better-auth.session_token='))
				.join('; ')}`;
		}
		const response =
			failure === 'cancelled' ? await flow.callback(cookie, `error=access_denied&state=${flow.state}`) : await flow.callback(cookie);
		expect(response.headers.get('location')).not.toContain('reauth=success');
		const [remaining] = await database.select().from(session).where(eq(session.id, current.id));
		expect(remaining?.authenticatedAt).toBeFalsy();
	},
);

it('rejects a callback from a provider other than the selected provider', async () => {
	const current = await seed('google');
	const flow = await startVerification(current);
	const context = await flow.auth.$context;
	const provider = context.socialProviders.find((entry) => entry.id === 'github');
	if (!provider) throw new Error('Missing test provider');
	vi.spyOn(provider, 'validateAuthorizationCode').mockResolvedValue({ accessToken: 'test-access-token' });
	vi.spyOn(provider, 'getUserInfo').mockResolvedValue({
		user: { id: current.accountId, name: 'Tester', email: `${current.userId}@example.test`, emailVerified: true },
		data: { id: current.accountId },
	});
	const response = await flow.auth.handler(
		new Request(`${baseURL}/api/auth/callback/github?code=test-code&state=${flow.state}`, { headers: { cookie: flow.cookie } }),
	);
	expect(response.headers.get('location')).not.toContain('reauth=success');
	const [unchanged] = await database.select().from(session).where(eq(session.id, current.id));
	expect(unchanged.authenticatedAt).toBeFalsy();
	expect(await database.select().from(account).where(eq(account.userId, current.userId))).toHaveLength(1);
});

it('rejects forged challenges without linking a new identity', async () => {
	const current = await seed();
	const flow = await startVerification(current, { intent: 'link', reauthenticationChallenge: crypto.randomUUID() });
	flow.identity.mockResolvedValue({
		user: { id: 'new-identity', name: 'Other', email: 'other@example.test', emailVerified: true },
		data: { id: 'new-identity' },
	});
	expect(await callbackLocation(flow)).toContain('reauth=error');
	expect(await database.select().from(account).where(eq(account.userId, current.userId))).toHaveLength(1);
	expect(await database.select().from(session).where(eq(session.userId, current.userId))).toHaveLength(1);
});

it('consumes a challenge once under concurrent callbacks', async () => {
	const current = await seed();
	const flow = await startVerification(current);
	const responses = await Promise.all([flow.callback(), flow.callback()]);
	expect(responses.filter((response) => response.headers.get('location')?.includes('reauth=success'))).toHaveLength(1);
});

it.each([false, true])('routine renewal does not refresh verification freshness (verified: %s)', async (verified) => {
	const current = await seed();
	if (verified) await database.update(session).set({ authenticatedAt: current.createdAt }).where(eq(session.id, current.id));
	const auth = createAuth(environment, baseURL);
	await auth.api.getSession({ headers: new Headers({ cookie: current.cookie }), query: { disableCookieCache: true } });
	const [renewed] = await database.select().from(session).where(eq(session.id, current.id));
	expect(renewed.createdAt).toEqual(current.createdAt);
	expect(renewed.authenticatedAt?.getTime()).toEqual(verified ? current.createdAt.getTime() : undefined);
	expect(renewed.updatedAt.getTime()).toBeGreaterThan(current.createdAt.getTime());
});
