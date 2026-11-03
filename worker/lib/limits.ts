import { eq } from 'drizzle-orm';

import { getOrgLimits } from '@shared/constants/plans';
import {
	ENTITLEMENT_ORG_MAX_MEMBERS,
	ENTITLEMENT_ORG_MAX_RUNNING_CONTAINERS,
	ENTITLEMENT_ORG_MAX_PROJECTS,
	ENTITLEMENT_ORG_STORAGE_QUOTA_BYTES,
	ENTITLEMENT_PROJECT_STORAGE_QUOTA_BYTES,
	ENTITLEMENT_USER_MAX_FREE_ORGS,
} from '@shared/entitlements';
import {
	DEFAULT_MAX_FREE_ORGS,
	EFFECTIVE_LIMIT_ORG_MAX_MEMBERS,
	EFFECTIVE_LIMIT_ORG_MAX_RUNNING_CONTAINERS,
	EFFECTIVE_LIMIT_ORG_MAX_PENDING_INVITATIONS,
	EFFECTIVE_LIMIT_ORG_MAX_PROJECTS,
	EFFECTIVE_LIMIT_ORG_STORAGE_QUOTA_BYTES,
	EFFECTIVE_LIMIT_PROJECT_STORAGE_QUOTA_BYTES,
	EFFECTIVE_LIMIT_USER_MAX_FREE_ORGANIZATIONS,
} from '@shared/limits';

import { queryEntitlement } from './entitlements';
import * as schema from '../db/auth-schema';

import type { EntitlementKey, OrgEntitlementKey } from '@shared/entitlements';
import type { OrgEffectiveLimitKey, ProjectEffectiveLimitKey, UserEffectiveLimitKey } from '@shared/limits';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

export type Database = DrizzleD1Database<typeof schema>;

type OrgLimitLookupInput = {
	organizationId: string;
	plan?: string;
};

type ProjectLimitLookupInput = {
	projectId: string;
};

type UserEffectiveLimitRequest = {
	key: UserEffectiveLimitKey;
	userId: string;
};

type OrgEffectiveLimitRequest = OrgLimitLookupInput & {
	key: OrgEffectiveLimitKey;
};

type ProjectEffectiveLimitRequest = ProjectLimitLookupInput & {
	key: ProjectEffectiveLimitKey;
};

type OrganizationPlanLimitKey = 'maxProjects' | 'maxMembers' | 'maxPendingInvitations' | 'storageQuotaBytes';

async function getOrganizationPlan(database: Database, organizationId: string): Promise<string> {
	const organizationRows = await database
		.select({ plan: schema.organization.plan })
		.from(schema.organization)
		.where(eq(schema.organization.id, organizationId))
		.limit(1);

	return organizationRows[0]?.plan ?? 'free';
}

async function getProjectOrganizationId(database: Database, projectId: string): Promise<string | undefined> {
	const projectRows = await database
		.select({ organizationId: schema.project.organizationId })
		.from(schema.project)
		.where(eq(schema.project.id, projectId))
		.limit(1);

	return projectRows[0]?.organizationId;
}

async function getEntitlementNumber(database: Database, scopeId: string, key: EntitlementKey): Promise<number | undefined> {
	const entitlementRows = await queryEntitlement(database, scopeId, key);
	const row = entitlementRows[0];
	const value = row?.valueType === 'number' ? Number(row.value) : undefined;
	return value !== undefined && Number.isFinite(value) ? value : undefined;
}

async function resolveOrganizationPlan(database: Database, request: OrgEffectiveLimitRequest): Promise<string> {
	return request.plan ?? getOrganizationPlan(database, request.organizationId);
}

async function resolveOrganizationLimit(
	database: Database,
	request: OrgEffectiveLimitRequest,
	planLimitKey: OrganizationPlanLimitKey,
	entitlementKey?: OrgEntitlementKey,
): Promise<number> {
	const [plan, override] = await Promise.all([
		resolveOrganizationPlan(database, request),
		entitlementKey ? getEntitlementNumber(database, request.organizationId, entitlementKey) : Promise.resolve(),
	]);

	return override ?? getOrgLimits(plan)[planLimitKey];
}

export async function getEffectiveLimit(
	database: Database,
	request: UserEffectiveLimitRequest | OrgEffectiveLimitRequest | ProjectEffectiveLimitRequest,
): Promise<number> {
	switch (request.key) {
		case EFFECTIVE_LIMIT_ORG_MAX_RUNNING_CONTAINERS: {
			if (!('organizationId' in request)) throw new Error('Invalid organization effective limit request');
			const [plan, override] = await Promise.all([
				resolveOrganizationPlan(database, request),
				getEntitlementNumber(database, request.organizationId, ENTITLEMENT_ORG_MAX_RUNNING_CONTAINERS),
			]);
			return override !== undefined && Number.isSafeInteger(override) && override >= 0 ? override : getOrgLimits(plan).maxRunningContainers;
		}
		case EFFECTIVE_LIMIT_USER_MAX_FREE_ORGANIZATIONS: {
			if (!('userId' in request)) {
				throw new Error('Invalid user effective limit request');
			}
			const userRequest = request;
			const override = await getEntitlementNumber(database, userRequest.userId, ENTITLEMENT_USER_MAX_FREE_ORGS);
			return override ?? DEFAULT_MAX_FREE_ORGS;
		}
		case EFFECTIVE_LIMIT_ORG_MAX_PENDING_INVITATIONS: {
			if (!('organizationId' in request)) {
				throw new Error('Invalid organization effective limit request');
			}
			return resolveOrganizationLimit(database, request, 'maxPendingInvitations');
		}
		case EFFECTIVE_LIMIT_ORG_MAX_PROJECTS: {
			if (!('organizationId' in request)) {
				throw new Error('Invalid organization effective limit request');
			}
			return resolveOrganizationLimit(database, request, 'maxProjects', ENTITLEMENT_ORG_MAX_PROJECTS);
		}
		case EFFECTIVE_LIMIT_ORG_MAX_MEMBERS: {
			if (!('organizationId' in request)) {
				throw new Error('Invalid organization effective limit request');
			}
			return resolveOrganizationLimit(database, request, 'maxMembers', ENTITLEMENT_ORG_MAX_MEMBERS);
		}
		case EFFECTIVE_LIMIT_ORG_STORAGE_QUOTA_BYTES: {
			if (!('organizationId' in request)) {
				throw new Error('Invalid organization effective limit request');
			}
			return resolveOrganizationLimit(database, request, 'storageQuotaBytes', ENTITLEMENT_ORG_STORAGE_QUOTA_BYTES);
		}
		case EFFECTIVE_LIMIT_PROJECT_STORAGE_QUOTA_BYTES: {
			if (!('projectId' in request)) {
				throw new Error('Invalid project effective limit request');
			}
			const projectRequest = request;
			const organizationId = await getProjectOrganizationId(database, projectRequest.projectId);
			if (!organizationId) {
				return getOrgLimits('free').storageQuotaBytes;
			}

			const [plan, orgOverride, projectOverride] = await Promise.all([
				getOrganizationPlan(database, organizationId),
				getEntitlementNumber(database, organizationId, ENTITLEMENT_ORG_STORAGE_QUOTA_BYTES),
				getEntitlementNumber(database, projectRequest.projectId, ENTITLEMENT_PROJECT_STORAGE_QUOTA_BYTES),
			]);

			if (projectOverride !== undefined) return projectOverride;
			if (orgOverride !== undefined) return orgOverride;
			return getOrgLimits(plan).storageQuotaBytes;
		}
		default: {
			throw new Error('Unsupported effective limit key');
		}
	}
}
