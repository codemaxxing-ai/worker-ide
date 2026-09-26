import { getCookies } from 'better-auth/cookies';
import { and, eq, inArray, isNull, lte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { serialize } from 'hono/utils/cookie';

import { ENTITLEMENT_ORG_MAX_PROJECTS, ENTITLEMENT_USER_MAX_FREE_ORGS } from '@shared/entitlements';

import * as authSchema from '../db/auth-schema';

import type { AuthedEnvironment } from '../types';

export function registerDevelopmentAuthRoutes(app: Hono<AuthedEnvironment>): void {
	if (import.meta.env.DEV) {
		app.get('/api/auth/get-session', async (c) => {
			const { resolveDevelopmentSession } = await import('../lib/development-session');
			const result = await resolveDevelopmentSession(c.env.DB, c.req.raw.headers);
			if (!result) return c.json({ error: 'Unauthorized' }, 401);
			return c.json(result);
		});

		app.get('/api/auth/list-organizations', async (c) => {
			const { resolveDevelopmentSession } = await import('../lib/development-session');
			const result = await resolveDevelopmentSession(c.env.DB, c.req.raw.headers);
			if (!result) return c.json({ error: 'Unauthorized' }, 401);

			const database = drizzle(c.env.DB, { schema: authSchema });
			const memberships = await database
				.select({ organizationId: authSchema.member.organizationId })
				.from(authSchema.member)
				.where(eq(authSchema.member.userId, result.user.id));

			const organizationIds = memberships.map((m) => m.organizationId);
			if (organizationIds.length === 0) return c.json([]);

			const organizations = await database
				.select()
				.from(authSchema.organization)
				.where(and(inArray(authSchema.organization.id, organizationIds), isNull(authSchema.organization.deletedAt)));
			return c.json(organizations);
		});

		app.post('/api/auth/organization/set-active', async (c) => {
			const { resolveDevelopmentSession } = await import('../lib/development-session');
			const result = await resolveDevelopmentSession(c.env.DB, c.req.raw.headers);
			if (!result) return c.json({ error: 'Unauthorized' }, 401);

			const body = await c.req.json<{ organizationId: string }>();
			if (!body.organizationId || typeof body.organizationId !== 'string') {
				return c.json({ error: 'Missing organizationId' }, 400);
			}
			const database = drizzle(c.env.DB, { schema: authSchema });

			const membership = await database
				.select({ id: authSchema.member.id })
				.from(authSchema.member)
				.innerJoin(authSchema.organization, eq(authSchema.organization.id, authSchema.member.organizationId))
				.where(
					and(
						eq(authSchema.member.organizationId, body.organizationId),
						eq(authSchema.member.userId, result.user.id),
						isNull(authSchema.organization.deletedAt),
					),
				)
				.limit(1);
			if (membership.length === 0) return c.json({ error: 'Forbidden' }, 403);

			const now = new Date();
			await database
				.update(authSchema.session)
				.set({ activeOrganizationId: body.organizationId, updatedAt: now })
				.where(eq(authSchema.session.id, result.session.id));

			return c.json({ ...result.session, activeOrganizationId: body.organizationId, updatedAt: now });
		});
	}
}

export function registerDevelopmentTestRoutes(app: Hono<AuthedEnvironment>): void {
	if (import.meta.env.DEV) {
		app.post('/__test/create-session', async (c) => {
			try {
				const database = drizzle(c.env.DB, { schema: authSchema });
				const userId = 'e2e-test-user';
				const organizationId = '11111111-1111-4111-8111-111111111111';
				const organizationSlug = '22222222-2222-4222-8222-222222222222';
				const memberId = 'e2e-test-member';
				const sessionId = 'e2e-test-session';
				const sessionToken = 'e2e-test-session-token';
				const now = new Date();
				const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

				await database
					.insert(authSchema.user)
					.values({
						id: userId,
						name: 'E2E Test User',
						email: 'e2e@test.local',
						emailVerified: false,
						createdAt: now,
						updatedAt: now,
					})
					.onConflictDoUpdate({
						target: authSchema.user.id,
						set: { updatedAt: now },
					});

				await database
					.insert(authSchema.organization)
					.values({ id: organizationId, name: 'E2E Test Org', slug: organizationSlug, plan: 'free', createdAt: now })
					.onConflictDoUpdate({
						target: authSchema.organization.id,
						set: { plan: 'free', slug: organizationSlug },
					});

				await database
					.insert(authSchema.member)
					.values({ id: memberId, organizationId, userId, role: 'owner', createdAt: now })
					.onConflictDoUpdate({
						target: authSchema.member.id,
						set: { organizationId, userId, role: 'owner', createdAt: now },
					});

				await database
					.insert(authSchema.entitlement)
					.values({
						id: 'e2e-test-max-free-orgs',
						scopeId: userId,
						key: ENTITLEMENT_USER_MAX_FREE_ORGS,
						valueType: 'number',
						value: '100',
						createdAt: now,
						updatedAt: now,
					})
					.onConflictDoUpdate({
						target: authSchema.entitlement.id,
						set: {
							scopeId: userId,
							key: ENTITLEMENT_USER_MAX_FREE_ORGS,
							valueType: 'number',
							value: '100',
							updatedAt: now,
						},
					});

				await database
					.insert(authSchema.entitlement)
					.values({
						id: 'e2e-test-org-max-projects',
						scopeId: organizationId,
						key: ENTITLEMENT_ORG_MAX_PROJECTS,
						valueType: 'number',
						value: '100',
						createdAt: now,
						updatedAt: now,
					})
					.onConflictDoUpdate({
						target: authSchema.entitlement.id,
						set: {
							scopeId: organizationId,
							key: ENTITLEMENT_ORG_MAX_PROJECTS,
							valueType: 'number',
							value: '100',
							updatedAt: now,
						},
					});

				// Purge stale test projects (older than 5 min) so the org limit is never
				// hit from prior runs, without deleting projects that a concurrent
				// Playwright worker may be actively using.
				const staleThreshold = new Date(now.getTime() - 5 * 60 * 1000);
				await database
					.delete(authSchema.project)
					.where(and(eq(authSchema.project.organizationId, organizationId), lte(authSchema.project.createdAt, staleThreshold)));

				// Upsert the session so concurrent Playwright workers don't race on
				// delete-then-insert with the same primary key.
				await database
					.insert(authSchema.session)
					.values({
						id: sessionId,
						token: sessionToken,
						userId,
						expiresAt,
						createdAt: now,
						updatedAt: now,
					})
					.onConflictDoUpdate({
						target: authSchema.session.id,
						set: { expiresAt, updatedAt: now },
					});

				const { sessionToken: sessionCookie } = getCookies({ baseURL: 'http://localhost' });
				c.header('Set-Cookie', serialize(sessionCookie.name, sessionToken, sessionCookie.attributes));
				return c.json({ userId, organizationId, sessionToken });
			} catch (error) {
				console.error('/__test/create-session failed:', error);
				return c.json({ error: String(error) }, 500);
			}
		});

		app.post('/__test/cleanup', async (c) => {
			try {
				const database = drizzle(c.env.DB, { schema: authSchema });
				const organizationId = '11111111-1111-4111-8111-111111111111';

				await database.delete(authSchema.project).where(eq(authSchema.project.organizationId, organizationId));

				return c.json({ ok: true });
			} catch (error) {
				console.error('/__test/cleanup failed:', error);
				return c.json({ error: String(error) }, 500);
			}
		});
	}
}
