import { zValidator } from '@hono/zod-validator';
import { and, count, desc, eq, gt, inArray, isNull, ne, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { z } from 'zod';

import { resolveUserPreferences } from '@shared/constants';
import { HttpErrorCode } from '@shared/http-errors';
import { EFFECTIVE_LIMIT_USER_MAX_FREE_ORGANIZATIONS } from '@shared/limits';
import {
	favoriteBodySchema,
	pushNotificationPreferenceBodySchema,
	pushSubscriptionBodySchema,
	pushUnsubscribeBodySchema,
	userPreferencesBodySchema,
} from '@shared/validation';

import { softDeleteOrganizationById } from './org-routes';
import * as schema from '../db/auth-schema';
import { trackAuthEvent } from '../lib/analytics';
import { httpError } from '../lib/http-error';
import { getEffectiveLimit } from '../lib/limits';
import { getCurrentFreeOrganizationCount } from '../lib/organization-limits';

import type { AuthedEnvironment } from '../types';

const MAX_RECENT_PROJECTS = 20;
const SESSION_FRESHNESS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const sessionIdParameterSchema = z.object({ id: z.uuid() });

interface UserDeletionImpact {
	blockers: Array<{ id: string; name: string; memberCount: number }>;
	singleMemberOrganizations: Array<{ id: string; name: string; projectCount: number }>;
	membershipOrganizations: Array<{ id: string; name: string }>;
}

async function requireFreshSession(database: ReturnType<typeof drizzle>, currentSession: { id: string; userId: string }) {
	const currentSessionRows = await database
		.select({ createdAt: schema.session.createdAt, authenticatedAt: schema.session.authenticatedAt })
		.from(schema.session)
		.where(
			and(
				eq(schema.session.id, currentSession.id),
				eq(schema.session.userId, currentSession.userId),
				gt(schema.session.expiresAt, new Date()),
			),
		)
		.limit(1);
	const currentSessionRow = currentSessionRows[0];

	if (!currentSessionRow) {
		throw httpError(HttpErrorCode.UNAUTHORIZED, 'Session is no longer valid');
	}

	if (Date.now() - (currentSessionRow.authenticatedAt ?? currentSessionRow.createdAt).getTime() >= SESSION_FRESHNESS_MAX_AGE_MS) {
		throw httpError(HttpErrorCode.SESSION_NOT_FRESH, 'Sign in again to manage sessions');
	}
}

async function getUserDeletionImpact(database: ReturnType<typeof drizzle>, userId: string): Promise<UserDeletionImpact> {
	const memberships = await database
		.select({
			organizationId: schema.member.organizationId,
			role: schema.member.role,
		})
		.from(schema.member)
		.innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
		.where(and(eq(schema.member.userId, userId), isNull(schema.organization.deletedAt)));

	const blockers: Array<{ id: string; name: string; memberCount: number }> = [];
	const singleMemberOrganizations: Array<{ id: string; name: string; projectCount: number }> = [];
	const membershipOrganizations: Array<{ id: string; name: string }> = [];

	for (const membership of memberships) {
		const [activeMembers, organizationRows] = await Promise.all([
			database
				.select({ userId: schema.member.userId, role: schema.member.role })
				.from(schema.member)
				.innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
				.where(
					and(
						eq(schema.member.organizationId, membership.organizationId),
						or(eq(schema.member.userId, userId), isNull(schema.user.deletedAt)),
					),
				),
			database
				.select({ name: schema.organization.name })
				.from(schema.organization)
				.where(eq(schema.organization.id, membership.organizationId))
				.limit(1),
		]);

		const organizationName = organizationRows[0]?.name ?? 'Unknown';
		const otherActiveMembers = activeMembers.filter((member) => member.userId !== userId);

		if (otherActiveMembers.length === 0) {
			const projectCountRows = await database
				.select({ count: count() })
				.from(schema.project)
				.where(and(eq(schema.project.organizationId, membership.organizationId), isNull(schema.project.deletedAt)));

			singleMemberOrganizations.push({
				id: membership.organizationId,
				name: organizationName,
				projectCount: projectCountRows[0]?.count ?? 0,
			});
			continue;
		}

		const otherOwners = otherActiveMembers.filter((member) => member.role === 'owner');
		if (membership.role === 'owner' && otherOwners.length === 0) {
			blockers.push({
				id: membership.organizationId,
				name: organizationName,
				memberCount: activeMembers.length,
			});
			continue;
		}

		membershipOrganizations.push({
			id: membership.organizationId,
			name: organizationName,
		});
	}

	return {
		blockers,
		singleMemberOrganizations,
		membershipOrganizations,
	};
}

export const userRoutes = new Hono<AuthedEnvironment>()
	.get('/user/reauthentication-providers', async (context) => {
		const current = context.get('session');
		const linked = await drizzle(context.env.DB)
			.select({ providerId: schema.account.providerId })
			.from(schema.account)
			.where(eq(schema.account.userId, current.userId));
		const providers = [...new Set(linked.map((entry) => entry.providerId))].filter(
			(provider): provider is 'google' | 'github' =>
				(provider === 'google' && Boolean(context.env.GOOGLE_CLIENT_ID && context.env.GOOGLE_CLIENT_SECRET)) ||
				(provider === 'github' && Boolean(context.env.GITHUB_CLIENT_ID && context.env.GITHUB_CLIENT_SECRET)),
		);
		return context.json({ providers });
	})
	// GET /api/user/sessions — Active sessions without exposing bearer tokens
	.get('/user/sessions', async (c) => {
		const currentSession = c.get('session');
		const database = drizzle(c.env.DB, { schema });
		const now = new Date();
		const sessions = await database
			.select({
				id: schema.session.id,
				userAgent: schema.session.userAgent,
				ipAddress: schema.session.ipAddress,
				createdAt: schema.session.createdAt,
			})
			.from(schema.session)
			.where(and(eq(schema.session.userId, currentSession.userId), gt(schema.session.expiresAt, now)))
			.orderBy(desc(schema.session.createdAt));

		return c.json({
			sessions: sessions.map((session) => ({
				id: session.id,
				userAgent: session.userAgent ?? undefined,
				ipAddress: session.ipAddress ?? undefined,
				createdAt: session.createdAt,
				current: session.id === currentSession.id,
			})),
		});
	})

	// DELETE /api/user/sessions/:id — Revoke an owned non-current session by opaque ID
	.delete('/user/sessions/:id', zValidator('param', sessionIdParameterSchema), async (c) => {
		const currentSession = c.get('session');
		const { id } = c.req.valid('param');
		const database = drizzle(c.env.DB, { schema });
		await requireFreshSession(database, currentSession);
		const deletedSessions = await database
			.delete(schema.session)
			.where(and(eq(schema.session.id, id), eq(schema.session.userId, currentSession.userId), ne(schema.session.id, currentSession.id)))
			.returning({ id: schema.session.id });

		if (deletedSessions.length === 0) {
			throw httpError(HttpErrorCode.NOT_FOUND, 'Session not found');
		}

		return c.json({ revoked: true });
	})

	// DELETE /api/user/sessions — Revoke every other session without ending the current session
	.delete('/user/sessions', async (c) => {
		const currentSession = c.get('session');
		const database = drizzle(c.env.DB, { schema });
		await requireFreshSession(database, currentSession);
		await database
			.delete(schema.session)
			.where(and(eq(schema.session.userId, currentSession.userId), ne(schema.session.id, currentSession.id)));

		return c.json({ revoked: true });
	})

	// GET /api/user/limits — Resolved limits + current usage for the authenticated user
	.get('/user/limits', async (c) => {
		const { userId } = c.get('session');
		const database = drizzle(c.env.DB, { schema: schema });

		const [maxFreeOrganizations, currentFreeOrganizations] = await Promise.all([
			getEffectiveLimit(database, { key: EFFECTIVE_LIMIT_USER_MAX_FREE_ORGANIZATIONS, userId }),
			getCurrentFreeOrganizationCount(database, userId),
		]);

		return c.json({
			maxFreeOrganizations,
			currentFreeOrganizations,
		});
	})

	// GET /api/user/recent-projects — Recently accessed projects across all orgs
	.get('/user/recent-projects', async (c) => {
		const { userId } = c.get('session');
		const database = drizzle(c.env.DB, { schema: schema });

		// Get all orgs the user belongs to
		const memberships = await database
			.select({ organizationId: schema.member.organizationId })
			.from(schema.member)
			.innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
			.where(and(eq(schema.member.userId, userId), isNull(schema.organization.deletedAt)));

		const organizationIds = memberships.map((m) => m.organizationId);
		if (organizationIds.length === 0) {
			return c.json({ projects: [] });
		}

		// Get user's project access records
		const accessRecords = await database
			.select()
			.from(schema.userProjectAccess)
			.where(eq(schema.userProjectAccess.userId, userId))
			.orderBy(desc(schema.userProjectAccess.lastAccessedAt))
			.limit(MAX_RECENT_PROJECTS);

		if (accessRecords.length === 0) {
			return c.json({ projects: [] });
		}

		const projectIds = accessRecords.map((record) => record.projectId);
		const favoriteRecords = await database
			.select({ projectId: schema.userProjectFavorite.projectId })
			.from(schema.userProjectFavorite)
			.where(and(eq(schema.userProjectFavorite.userId, userId), inArray(schema.userProjectFavorite.projectId, projectIds)));

		// Get project details for accessed projects (only non-deleted, non-banned ones in user's non-banned orgs)
		const projects = await database
			.select({
				id: schema.project.id,
				organizationId: schema.project.organizationId,
				name: schema.project.name,
				previewVisibility: schema.project.previewVisibility,
				createdAt: schema.project.createdAt,
				updatedAt: schema.project.updatedAt,
			})
			.from(schema.project)
			.leftJoin(schema.organization, eq(schema.project.organizationId, schema.organization.id))
			.where(
				and(
					inArray(schema.project.id, projectIds),
					inArray(schema.project.organizationId, organizationIds),
					isNull(schema.project.deletedAt),
					isNull(schema.project.bannedAt),
					isNull(schema.organization.deletedAt),
					isNull(schema.organization.bannedAt),
				),
			);

		// Get org names for labeling
		const orgIds = [...new Set(projects.map((p) => p.organizationId))];
		const organizations =
			orgIds.length > 0
				? await database
						.select({ id: schema.organization.id, name: schema.organization.name, slug: schema.organization.slug })
						.from(schema.organization)
						.where(inArray(schema.organization.id, orgIds))
				: [];
		const organizationMap = new Map(organizations.map((o) => [o.id, o]));

		// Merge access info with project details
		const accessMap = new Map(accessRecords.map((record) => [record.projectId, record]));
		const favoriteProjectIds = new Set(favoriteRecords.map((record) => record.projectId));
		const projectsWithAccess = projects
			.map((project) => {
				const access = accessMap.get(project.id);
				const organization = organizationMap.get(project.organizationId);
				return {
					...project,
					lastAccessedAt: access?.lastAccessedAt.toISOString() ?? project.updatedAt.toISOString(),
					isFavorite: favoriteProjectIds.has(project.id),
					organizationName: organization?.name ?? 'Unknown',
					organizationSlug: organization?.slug ?? '',
				};
			})
			.toSorted((a, b) => {
				// Favorites first, then by last accessed
				if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
				return new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime();
			});

		return c.json({ projects: projectsWithAccess });
	})

	// PUT /api/user/project/:projectId/favorite — Set favorite status
	.put('/user/project/:projectId/favorite', zValidator('json', favoriteBodySchema), async (c) => {
		const { userId } = c.get('session');
		const { projectId } = c.req.param();
		const database = drizzle(c.env.DB, { schema: schema });

		const body = c.req.valid('json');

		// Verify user is a member of the project's organization
		const projectMember = await database
			.select({ memberId: schema.member.id })
			.from(schema.project)
			.innerJoin(schema.organization, eq(schema.organization.id, schema.project.organizationId))
			.leftJoin(schema.member, and(eq(schema.member.organizationId, schema.project.organizationId), eq(schema.member.userId, userId)))
			.where(and(eq(schema.project.id, projectId), isNull(schema.project.deletedAt), isNull(schema.organization.deletedAt)))
			.limit(1);

		if (projectMember.length === 0 || !projectMember[0].memberId) {
			throw httpError(HttpErrorCode.FORBIDDEN, 'Forbidden');
		}

		if (!body.favorite) {
			await database
				.delete(schema.userProjectFavorite)
				.where(and(eq(schema.userProjectFavorite.userId, userId), eq(schema.userProjectFavorite.projectId, projectId)));

			return c.json({ projectId, favorite: body.favorite });
		}

		await database
			.insert(schema.userProjectFavorite)
			.values({
				id: crypto.randomUUID(),
				userId,
				projectId,
				createdAt: new Date(),
			})
			.onConflictDoNothing({ target: [schema.userProjectFavorite.userId, schema.userProjectFavorite.projectId] });

		return c.json({ projectId, favorite: body.favorite });
	})

	// GET /api/user/account/delete-preview — Preview account deletion consequences
	.get('/user/account/delete-preview', async (c) => {
		const { userId } = c.get('session');
		const database = drizzle(c.env.DB, { schema: schema });
		const { blockers, membershipOrganizations, singleMemberOrganizations } = await getUserDeletionImpact(database, userId);

		return c.json({
			canDelete: blockers.length === 0,
			blockers,
			singleMemberOrganizations,
			membershipOrganizations,
		});
	})

	// DELETE /api/user/account — Soft-delete user account
	.delete('/user/account', async (c) => {
		const { userId } = c.get('session');
		const database = drizzle(c.env.DB, { schema: schema });
		const deletionImpact = await getUserDeletionImpact(database, userId);

		if (deletionImpact.blockers.length > 0) {
			throw httpError(
				HttpErrorCode.VALIDATION_ERROR,
				'Cannot delete account: you are the sole super admin of a multi-member organization. Promote another member or delete the organization first.',
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- 409 Conflict is not in Hono's standard status type
				409 as 400,
			);
		}

		const now = new Date();

		// Single-member orgs follow the same soft-delete flow as direct org deletion.
		for (const organization of deletionImpact.singleMemberOrganizations) {
			await softDeleteOrganizationById(database, organization.id, now, userId);
		}

		// Batch the final user-level cleanup
		await database.batch([
			// Cancel any pending transfers initiated by the user
			database
				.update(schema.projectTransfer)
				.set({ status: 'cancelled', resolvedAt: now, resolvedByUserId: userId })
				.where(and(eq(schema.projectTransfer.status, 'pending'), eq(schema.projectTransfer.initiatedByUserId, userId))),
			// Soft-delete the user
			database.update(schema.user).set({ deletedAt: now, updatedAt: now }).where(eq(schema.user.id, userId)),
			// Delete all sessions
			database.delete(schema.session).where(eq(schema.session.userId, userId)),
		]);

		trackAuthEvent({ userId, eventType: 'account_delete', request: c.req.raw });

		return c.json({ ok: true, deletedAt: now.toISOString() });
	})

	// =========================================================================
	// Push Notification Subscription Management
	// =========================================================================

	// GET /api/user/push-vapid-key — Get the VAPID public key for pushManager.subscribe()
	.get('/user/push-vapid-key', async (c) => {
		const key = await c.env.PUSH.getVapidPublicKey();
		return c.json({ key });
	})

	// POST /api/user/push-subscription — Register a push subscription
	.post('/user/push-subscription', zValidator('json', pushSubscriptionBodySchema), async (c) => {
		const { userId } = c.get('session');
		const body = c.req.valid('json');

		await c.env.PUSH.registerSubscription(userId, {
			endpoint: body.endpoint,
			key: body.key,
			auth: body.auth,
		});

		return c.json({ ok: true });
	})

	// DELETE /api/user/push-subscription — Unregister a push subscription
	.delete('/user/push-subscription', zValidator('json', pushUnsubscribeBodySchema), async (c) => {
		const { userId } = c.get('session');
		const body = c.req.valid('json');

		await c.env.PUSH.unregisterSubscription(userId, body.endpoint);

		return c.json({ ok: true });
	})

	// =========================================================================
	// Push Notification Preference (per-device enabled/disabled)
	// =========================================================================

	// GET /api/user/push-notification-preference — Get preference for a device
	.get('/user/push-notification-preference', async (c) => {
		const { userId } = c.get('session');
		const endpoint = c.req.query('endpoint');

		if (!endpoint) {
			throw httpError(HttpErrorCode.VALIDATION_ERROR, 'Query parameter "endpoint" is required.');
		}

		const preference = await c.env.PUSH.getNotificationPreference(userId, endpoint);
		return c.json({ enabled: preference?.enabled ?? false });
	})

	// PUT /api/user/push-notification-preference — Set preference for a device
	.put('/user/push-notification-preference', zValidator('json', pushNotificationPreferenceBodySchema), async (c) => {
		const { userId } = c.get('session');
		const body = c.req.valid('json');

		await c.env.PUSH.setNotificationPreference(userId, body.endpoint, body.enabled);

		return c.json({ ok: true });
	})

	// GET /api/user/preferences — All user preferences merged with defaults
	.get('/user/preferences', async (c) => {
		const { userId } = c.get('session');
		const database = drizzle(c.env.DB, { schema: schema });

		const rows = await database
			.select({ key: schema.userPreference.key, value: schema.userPreference.value })
			.from(schema.userPreference)
			.where(eq(schema.userPreference.userId, userId));

		const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
		return c.json(resolveUserPreferences(stored));
	})

	// PUT /api/user/preferences — Upsert one or more preference key-value pairs
	.put('/user/preferences', zValidator('json', userPreferencesBodySchema), async (c) => {
		const { userId } = c.get('session');
		const preferences = c.req.valid('json');
		const database = drizzle(c.env.DB, { schema: schema });
		const now = new Date();

		// Upsert each preference. Typically 1-2 keys per call.
		for (const [key, value] of Object.entries(preferences)) {
			await database
				.insert(schema.userPreference)
				.values({ userId, key, value, updatedAt: now })
				.onConflictDoUpdate({
					target: [schema.userPreference.userId, schema.userPreference.key],
					set: { value, updatedAt: now },
				});
		}

		return c.json({ ok: true });
	});

export type UserRoutes = typeof userRoutes;
