import { env } from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';

import { userRoutes } from './user-routes';
import * as schema from '../db/auth-schema';

import type { AuthedEnvironment } from '../types';

const database = drizzle(env.DB, { schema });

beforeAll(async () => {
	await env.DB.exec(
		`CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, email_verified INTEGER NOT NULL DEFAULT 0, image TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, banned_at INTEGER, role TEXT NOT NULL DEFAULT 'user', banned INTEGER DEFAULT 0, ban_reason TEXT, ban_expires INTEGER)`,
	);
	await env.DB.exec(
		`CREATE TABLE IF NOT EXISTS "session" (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, authenticated_at INTEGER, token TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ip_address TEXT, user_agent TEXT, user_id TEXT NOT NULL, active_organization_id TEXT, impersonated_by TEXT)`,
	);
	await env.DB.exec('CREATE TABLE IF NOT EXISTS account (provider_id TEXT NOT NULL, user_id TEXT NOT NULL)');
});

function createId(): string {
	return crypto.randomUUID();
}

async function insertUser() {
	const id = createId();
	const now = new Date();
	await database.insert(schema.user).values({
		id,
		name: 'Test User',
		email: `${id}@example.com`,
		emailVerified: false,
		createdAt: now,
		updatedAt: now,
	});
	return id;
}

async function insertSession(userId: string, options: { expiresAt?: Date; createdAt?: Date } = {}) {
	const id = createId();
	const createdAt = options.createdAt ?? new Date();
	await database.insert(schema.session).values({
		id,
		token: `secret-${createId()}`,
		userId,
		expiresAt: options.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
		createdAt,
		updatedAt: createdAt,
		ipAddress: '203.0.113.1',
		userAgent: 'Test browser',
	});
	return id;
}

function createApp(currentSession: { id: string; userId: string }) {
	return new Hono<AuthedEnvironment>()
		.use('*', async (c, next) => {
			c.set('session', { ...currentSession, updateActivity: true, collaborationVisible: true });
			await next();
		})
		.route('/', userRoutes);
}

describe('user session routes', () => {
	it('offers only configured providers linked to the current account', async () => {
		const userId = await insertUser();
		const currentSessionId = await insertSession(userId);
		await env.DB.prepare('INSERT INTO account (provider_id, user_id) VALUES (?, ?), (?, ?)').bind('google', userId, 'github', userId).run();
		const response = await createApp({ id: currentSessionId, userId }).request(
			'https://example.com/user/reauthentication-providers',
			{},
			{
				...env,
				GOOGLE_CLIENT_ID: 'configured',
				GOOGLE_CLIENT_SECRET: 'configured',
				GITHUB_CLIENT_ID: '',
				GITHUB_CLIENT_SECRET: '',
			},
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ providers: ['google'] });
	});

	it('uses recent verification without changing session creation time', async () => {
		const userId = await insertUser();
		const createdAt = new Date(Math.floor((Date.now() - 3 * 24 * 60 * 60 * 1000) / 1000) * 1000);
		const currentSessionId = await insertSession(userId, { createdAt });
		const otherSessionId = await insertSession(userId);
		await database.update(schema.session).set({ authenticatedAt: new Date() }).where(eq(schema.session.id, currentSessionId));
		const response = await createApp({ id: currentSessionId, userId }).request(
			`https://example.com/user/sessions/${otherSessionId}`,
			{ method: 'DELETE' },
			env,
		);
		expect(response.status).toBe(200);
		const [current] = await database.select().from(schema.session).where(eq(schema.session.id, currentSessionId));
		expect(current.createdAt).toEqual(createdAt);
	});

	it('lists active owned sessions without exposing bearer tokens when the current session is older than 24 hours', async () => {
		const userId = await insertUser();
		const currentSessionCreatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
		const otherSessionCreatedAt = new Date(Date.now() - 48 * 60 * 60 * 1000);
		currentSessionCreatedAt.setMilliseconds(0);
		otherSessionCreatedAt.setMilliseconds(0);
		const currentSessionId = await insertSession(userId, { createdAt: currentSessionCreatedAt });
		const otherSessionId = await insertSession(userId, { createdAt: otherSessionCreatedAt });
		await insertSession(userId, { expiresAt: new Date('2020-01-01T00:00:00.000Z') });
		const anotherUserId = await insertUser();
		await insertSession(anotherUserId);

		const response = await createApp({ id: currentSessionId, userId }).request('https://example.com/user/sessions', {}, env);

		expect(response.status).toBe(200);
		const body: unknown = await response.json();
		expect(body).toEqual({
			sessions: [
				{
					id: currentSessionId,
					userAgent: 'Test browser',
					ipAddress: '203.0.113.1',
					createdAt: currentSessionCreatedAt.toISOString(),
					current: true,
				},
				{
					id: otherSessionId,
					userAgent: 'Test browser',
					ipAddress: '203.0.113.1',
					createdAt: otherSessionCreatedAt.toISOString(),
					current: false,
				},
			],
		});
		expect(JSON.stringify(body)).not.toContain('secret-');
	});

	it('only revokes other sessions owned by the authenticated user', async () => {
		const userId = await insertUser();
		const currentSessionId = await insertSession(userId);
		const otherSessionId = await insertSession(userId);
		const anotherUserId = await insertUser();
		const anotherUserSessionId = await insertSession(anotherUserId);
		const app = createApp({ id: currentSessionId, userId });

		const revokeResponse = await app.request(`https://example.com/user/sessions/${otherSessionId}`, { method: 'DELETE' }, env);
		expect(revokeResponse.status).toBe(200);

		const revokeCurrentResponse = await app.request(`https://example.com/user/sessions/${currentSessionId}`, { method: 'DELETE' }, env);
		expect(revokeCurrentResponse.status).toBe(404);

		const revokeOtherUserResponse = await app.request(
			`https://example.com/user/sessions/${anotherUserSessionId}`,
			{ method: 'DELETE' },
			env,
		);
		expect(revokeOtherUserResponse.status).toBe(404);

		const remainingSessions = await database
			.select({ id: schema.session.id })
			.from(schema.session)
			.where(and(eq(schema.session.id, currentSessionId), eq(schema.session.userId, userId)));
		expect(remainingSessions).toHaveLength(1);
	});

	it('signs out all other sessions while preserving the current one', async () => {
		const userId = await insertUser();
		const currentSessionId = await insertSession(userId);
		const otherSessionId = await insertSession(userId);

		const response = await createApp({ id: currentSessionId, userId }).request(
			'https://example.com/user/sessions',
			{ method: 'DELETE' },
			env,
		);
		expect(response.status).toBe(200);

		const remainingSessions = await database
			.select({ id: schema.session.id })
			.from(schema.session)
			.where(eq(schema.session.userId, userId));
		expect(remainingSessions).toEqual([{ id: currentSessionId }]);
		expect(remainingSessions).not.toContainEqual({ id: otherSessionId });
	});

	it('requires a sign-in within the last 24 hours before revoking sessions', async () => {
		const userId = await insertUser();
		const currentSessionId = await insertSession(userId, { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });
		const otherSessionId = await insertSession(userId);
		const app = createApp({ id: currentSessionId, userId });

		const revokeResponse = await app.request(`https://example.com/user/sessions/${otherSessionId}`, { method: 'DELETE' }, env);
		expect(revokeResponse.status).toBe(403);
		expect(await revokeResponse.json()).toEqual({
			error: 'Sign in again to manage sessions',
			code: 'SESSION_NOT_FRESH',
		});

		const revokeAllResponse = await app.request('https://example.com/user/sessions', { method: 'DELETE' }, env);
		expect(revokeAllResponse.status).toBe(403);

		const remainingSession = await database
			.select({ id: schema.session.id })
			.from(schema.session)
			.where(eq(schema.session.id, otherSessionId));
		expect(remainingSession).toEqual([{ id: otherSessionId }]);
	});
});
