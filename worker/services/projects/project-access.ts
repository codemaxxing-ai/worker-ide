import { and, eq, isNull } from 'drizzle-orm';

import { HttpErrorCode } from '@shared/http-errors';
import { EFFECTIVE_LIMIT_ORG_MAX_PROJECTS } from '@shared/limits';

import * as authSchema from '../../db/auth-schema';
import { httpError } from '../../lib/http-error';
import { getEffectiveLimit } from '../../lib/limits';

import type { DrizzleD1Database } from 'drizzle-orm/d1';

type ProjectDatabase = DrizzleD1Database<typeof authSchema>;
type OrganizationPlan = NonNullable<typeof authSchema.organization.$inferSelect.plan>;

async function requireProjectOrganization(database: ProjectDatabase, organizationId: string, userId: string): Promise<OrganizationPlan> {
	const orgMemberRow = await database
		.select({
			plan: authSchema.organization.plan,
			orgDeletedAt: authSchema.organization.deletedAt,
			orgBannedAt: authSchema.organization.bannedAt,
			memberId: authSchema.member.id,
		})
		.from(authSchema.organization)
		.leftJoin(
			authSchema.member,
			and(eq(authSchema.member.organizationId, authSchema.organization.id), eq(authSchema.member.userId, userId)),
		)
		.where(eq(authSchema.organization.id, organizationId))
		.limit(1);

	if (orgMemberRow.length === 0) {
		throw httpError(HttpErrorCode.FORBIDDEN, 'Forbidden', undefined, { includeCode: false });
	}
	if (orgMemberRow[0].orgDeletedAt) {
		throw httpError(HttpErrorCode.NOT_FOUND, 'Organization not found.', undefined, { includeCode: false });
	}
	if (orgMemberRow[0].orgBannedAt) {
		throw httpError(HttpErrorCode.FORBIDDEN, 'Forbidden', undefined, { includeCode: false });
	}
	if (!orgMemberRow[0].memberId) {
		throw httpError(HttpErrorCode.FORBIDDEN, 'You are not a member of this organization.', undefined, { includeCode: false });
	}

	return orgMemberRow[0].plan ?? 'free';
}

async function enforceProjectLimit(
	database: ProjectDatabase,
	organizationId: string,
	plan: OrganizationPlan,
	operation: 'create' | 'clone',
): Promise<void> {
	const orgMaxProjects = await getEffectiveLimit(database, {
		key: EFFECTIVE_LIMIT_ORG_MAX_PROJECTS,
		organizationId,
		plan,
	});
	const existingProjects = await database
		.select({ id: authSchema.project.id })
		.from(authSchema.project)
		.where(and(eq(authSchema.project.organizationId, organizationId), isNull(authSchema.project.deletedAt)));
	if (existingProjects.length < orgMaxProjects) {
		return;
	}

	const message =
		operation === 'create'
			? `Organization project limit reached (${orgMaxProjects}). Upgrade your plan to create more projects.`
			: `Organization project limit reached (${orgMaxProjects}).`;
	throw httpError(HttpErrorCode.VALIDATION_ERROR, message, undefined, { includeCode: false });
}

export { enforceProjectLimit, requireProjectOrganization, type ProjectDatabase };
