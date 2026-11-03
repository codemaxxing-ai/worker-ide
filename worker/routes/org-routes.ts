import { zValidator } from '@hono/zod-validator';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import { HttpErrorCode } from '@shared/http-errors';
import {
	EFFECTIVE_LIMIT_ORG_MAX_MEMBERS,
	EFFECTIVE_LIMIT_ORG_MAX_PENDING_INVITATIONS,
	EFFECTIVE_LIMIT_ORG_MAX_PROJECTS,
} from '@shared/limits';
import { visibilityBodySchema } from '@shared/validation';

import * as schema from '../db/auth-schema';
import { trackProjectEvent } from '../lib/analytics';
import { coordinatorNamespace, organizationContainerCapacityNamespace } from '../lib/durable-object-namespaces';
import { httpError } from '../lib/http-error';
import { getEffectiveLimit } from '../lib/limits';
import { assertOrgSuperAdmin } from '../lib/project-auth';

import type { AuthedEnvironment } from '../types';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

const PROJECT_DELETED_VIA_PROJECT = 'project';
const PROJECT_DELETED_VIA_ORGANIZATION = 'organization';

async function softDeleteProjectById(
	database: DrizzleD1Database<typeof schema>,
	projectId: string,
	now: Date,
	deletedViaType: string,
	deletedViaId: string,
	resolvedByUserId?: string,
): Promise<void> {
	await database.batch([
		database
			.update(schema.project)
			.set({ deletedAt: now, deletedViaType, deletedViaId, updatedAt: now })
			.where(and(eq(schema.project.id, projectId), isNull(schema.project.deletedAt))),
		database
			.update(schema.projectTransfer)
			.set({ status: 'cancelled', resolvedAt: now, resolvedByUserId })
			.where(and(eq(schema.projectTransfer.projectId, projectId), eq(schema.projectTransfer.status, 'pending'))),
	]);
}

export async function softDeleteOrganizationById(
	database: DrizzleD1Database<typeof schema>,
	organizationId: string,
	now: Date,
	resolvedByUserId?: string,
): Promise<void> {
	await database.batch([
		database
			.update(schema.projectTransfer)
			.set({ status: 'cancelled', resolvedAt: now, resolvedByUserId })
			.where(and(eq(schema.projectTransfer.status, 'pending'), eq(schema.projectTransfer.sourceOrganizationId, organizationId))),
		database
			.update(schema.projectTransfer)
			.set({ status: 'cancelled', resolvedAt: now, resolvedByUserId })
			.where(and(eq(schema.projectTransfer.status, 'pending'), eq(schema.projectTransfer.targetOrganizationId, organizationId))),
		database
			.update(schema.project)
			.set({ deletedAt: now, deletedViaType: PROJECT_DELETED_VIA_ORGANIZATION, deletedViaId: organizationId, updatedAt: now })
			.where(and(eq(schema.project.organizationId, organizationId), isNull(schema.project.deletedAt))),
		database.update(schema.organization).set({ deletedAt: now }).where(eq(schema.organization.id, organizationId)),
		database
			.update(schema.session)
			// eslint-disable-next-line unicorn/no-null -- D1 requires null to clear nullable columns
			.set({ activeOrganizationId: null, updatedAt: now })
			.where(eq(schema.session.activeOrganizationId, organizationId)),
	]);
}

export const orgRoutes = new Hono<AuthedEnvironment>()
	// Verify the user is a member of the :orgId organization and the org is not banned
	.use('/org/:orgId/*', async (c, next) => {
		const { orgId } = c.req.param();
		const { userId } = c.get('session');
		const database = drizzle(c.env.DB, { schema });

		// Single query: check membership + org ban
		const orgMemberRow = await database
			.select({
				memberId: schema.member.id,
				orgDeletedAt: schema.organization.deletedAt,
				orgBannedAt: schema.organization.bannedAt,
			})
			.from(schema.organization)
			.leftJoin(schema.member, and(eq(schema.member.organizationId, schema.organization.id), eq(schema.member.userId, userId)))
			.where(eq(schema.organization.id, orgId))
			.limit(1);

		if (orgMemberRow.length === 0) {
			throw httpError(HttpErrorCode.FORBIDDEN, 'Forbidden');
		}

		if (orgMemberRow[0].orgBannedAt) {
			throw httpError(HttpErrorCode.FORBIDDEN, 'Please contact us for assistance.');
		}

		if (orgMemberRow[0].orgDeletedAt) {
			throw httpError(HttpErrorCode.NOT_FOUND, 'Organization not found.');
		}

		if (!orgMemberRow[0].memberId) {
			throw httpError(HttpErrorCode.FORBIDDEN, 'You are not a member of this organization.');
		}

		await next();
	})

	// GET /api/org/:orgId/limits — Resolved limits + current usage for this organization
	.get('/org/:orgId/limits', async (c) => {
		const { orgId } = c.req.param();
		const database = drizzle(c.env.DB, { schema });

		const [maxProjects, maxMembers, maxPendingInvitations, projectCountRows, memberCountRows, pendingInvitationCountRows] =
			await Promise.all([
				getEffectiveLimit(database, { key: EFFECTIVE_LIMIT_ORG_MAX_PROJECTS, organizationId: orgId }),
				getEffectiveLimit(database, { key: EFFECTIVE_LIMIT_ORG_MAX_MEMBERS, organizationId: orgId }),
				getEffectiveLimit(database, { key: EFFECTIVE_LIMIT_ORG_MAX_PENDING_INVITATIONS, organizationId: orgId }),
				database
					.select({ count: count() })
					.from(schema.project)
					.where(and(eq(schema.project.organizationId, orgId), isNull(schema.project.deletedAt))),
				database
					.select({ count: count() })
					.from(schema.member)
					.innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
					.where(and(eq(schema.member.organizationId, orgId), isNull(schema.user.deletedAt))),
				database
					.select({ count: count() })
					.from(schema.invitation)
					.where(and(eq(schema.invitation.organizationId, orgId), eq(schema.invitation.status, 'pending'))),
			]);

		return c.json({
			maxProjects,
			...(await organizationContainerCapacityNamespace.getByName(`org:${orgId}`).status(orgId)),
			currentProjects: projectCountRows[0]?.count ?? 0,
			maxMembers,
			currentMembers: memberCountRows[0]?.count ?? 0,
			maxPendingInvitations,
			currentPendingInvitations: pendingInvitationCountRows[0]?.count ?? 0,
		});
	})

	// GET /api/org/:orgId/full — Organization details for settings pages
	.get('/org/:orgId/full', async (c) => {
		const { orgId } = c.req.param();
		const database = drizzle(c.env.DB, { schema });

		const [organizationRows, memberRows, invitationRows] = await Promise.all([
			database
				.select({
					id: schema.organization.id,
					name: schema.organization.name,
					slug: schema.organization.slug,
					logo: schema.organization.logo,
					plan: schema.organization.plan,
					createdAt: schema.organization.createdAt,
				})
				.from(schema.organization)
				.where(eq(schema.organization.id, orgId))
				.limit(1),
			database
				.select({
					id: schema.member.id,
					userId: schema.member.userId,
					role: schema.member.role,
					createdAt: schema.member.createdAt,
					userName: schema.user.name,
					userEmail: schema.user.email,
					userImage: schema.user.image,
				})
				.from(schema.member)
				.innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
				.where(and(eq(schema.member.organizationId, orgId), isNull(schema.user.deletedAt)))
				.orderBy(desc(schema.member.createdAt)),
			database
				.select({
					id: schema.invitation.id,
					email: schema.invitation.email,
					role: schema.invitation.role,
					status: schema.invitation.status,
					expiresAt: schema.invitation.expiresAt,
					inviterId: schema.invitation.inviterId,
					createdAt: schema.invitation.createdAt,
				})
				.from(schema.invitation)
				.where(eq(schema.invitation.organizationId, orgId))
				.orderBy(desc(schema.invitation.createdAt)),
		]);

		const organization = organizationRows[0];
		if (!organization) {
			throw httpError(HttpErrorCode.NOT_FOUND, 'Organization not found.');
		}

		return c.json({
			id: organization.id,
			name: organization.name,
			slug: organization.slug,
			logo: organization.logo,
			plan: organization.plan,
			createdAt: organization.createdAt.toISOString(),
			members: memberRows.map((member) => ({
				id: member.id,
				userId: member.userId,
				role: member.role,
				createdAt: member.createdAt.toISOString(),
				user: {
					id: member.userId,
					name: member.userName,
					email: member.userEmail,
					image: member.userImage ?? undefined,
				},
			})),
			invitations: invitationRows.map((invitation) => ({
				id: invitation.id,
				email: invitation.email,
				role: invitation.role ?? undefined,
				status: invitation.status,
				expiresAt: invitation.expiresAt.toISOString(),
				inviterId: invitation.inviterId ?? undefined,
				createdAt: invitation.createdAt.toISOString(),
			})),
		});
	})

	// GET /api/org/:orgId/projects — List projects for the organization
	.get('/org/:orgId/projects', async (c) => {
		const { orgId } = c.req.param();

		const database = drizzle(c.env.DB, { schema });
		const projects = await database
			.select({
				id: schema.project.id,
				organizationId: schema.project.organizationId,
				durableObjectHexId: schema.project.durableObjectHexId,
				name: schema.project.name,
				previewVisibility: schema.project.previewVisibility,
				createdAt: schema.project.createdAt,
				updatedAt: schema.project.updatedAt,
				deletedAt: schema.project.deletedAt,
				bannedAt: schema.project.bannedAt,
				lastActivityAt: schema.project.lastActivityAt,
			})
			.from(schema.project)
			.where(and(eq(schema.project.organizationId, orgId), isNull(schema.project.deletedAt), isNull(schema.project.bannedAt)))
			.orderBy(desc(schema.project.lastActivityAt));

		return c.json({ projects });
	})

	// PUT /api/org/:orgId/project/:projectId/visibility — Toggle preview visibility
	.put('/org/:orgId/project/:projectId/visibility', zValidator('json', visibilityBodySchema), async (c) => {
		const { orgId, projectId } = c.req.param();

		const body = c.req.valid('json');

		const database = drizzle(c.env.DB, { schema });
		const existing = await database
			.select()
			.from(schema.project)
			.where(
				and(
					eq(schema.project.id, projectId),
					eq(schema.project.organizationId, orgId),
					isNull(schema.project.deletedAt),
					isNull(schema.project.bannedAt),
				),
			)
			.limit(1);

		if (existing.length === 0) {
			throw httpError(HttpErrorCode.NOT_FOUND, 'Project not found in this organization.');
		}

		await database
			.update(schema.project)
			.set({ previewVisibility: body.visibility, updatedAt: new Date() })
			.where(eq(schema.project.id, projectId));

		return c.json({ projectId, visibility: body.visibility });
	})

	// DELETE /api/org/:orgId/project/:projectId — Soft-delete a project (30-day retention)
	.delete('/org/:orgId/project/:projectId', async (c) => {
		const { orgId, projectId } = c.req.param();

		const database = drizzle(c.env.DB, { schema });
		const existing = await database
			.select()
			.from(schema.project)
			.where(
				and(
					eq(schema.project.id, projectId),
					eq(schema.project.organizationId, orgId),
					isNull(schema.project.deletedAt),
					isNull(schema.project.bannedAt),
				),
			)
			.limit(1);

		if (existing.length === 0) {
			throw httpError(HttpErrorCode.NOT_FOUND, 'Project not found in this organization.');
		}

		const now = new Date();
		await softDeleteProjectById(database, projectId, now, PROJECT_DELETED_VIA_PROJECT, projectId, c.get('session').userId);
		await coordinatorNamespace.getByName(`project:${projectId}`).closeProjectConnections(4004, 'project-deleted');

		trackProjectEvent({
			organizationId: orgId,
			eventType: 'delete',
			projectId,
			userId: c.get('session').userId,
			durationMs: 0,
			success: true,
			request: c.req.raw,
		});

		return c.json({ projectId, deletedAt: now.toISOString() });
	})

	// DELETE /api/org/:orgId — Delete an organization (super admin only)
	.delete('/org/:orgId', async (c) => {
		const { orgId } = c.req.param();
		const { userId } = c.get('session');
		const database = drizzle(c.env.DB, { schema });

		// Only super admins (owners) can delete an org
		await assertOrgSuperAdmin(database, orgId, userId);

		const now = new Date();

		await softDeleteOrganizationById(database, orgId, now, userId);

		return c.json({ organizationId: orgId, deletedAt: now.toISOString() });
	});

export type OrgRoutes = typeof orgRoutes;
