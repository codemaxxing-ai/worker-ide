import { getOrgLimits } from './constants/plans';
import {
	ENTITLEMENT_ORG_MAX_MEMBERS,
	ENTITLEMENT_ORG_MAX_RUNNING_CONTAINERS,
	ENTITLEMENT_ORG_MAX_PROJECTS,
	ENTITLEMENT_ORG_STORAGE_QUOTA_BYTES,
	ENTITLEMENT_PROJECT_STORAGE_QUOTA_BYTES,
	ENTITLEMENT_USER_MAX_FREE_ORGS,
} from './entitlements';

import type { EntitlementValue } from './entitlements';

export const DEFAULT_MAX_FREE_ORGS = 3;

export const EFFECTIVE_LIMIT_INPUT_CACHE_NAME = 'limit-input-cache-v1';
export const EFFECTIVE_LIMIT_CACHE_ORIGIN = 'https://limit-cache.internal';

export function buildOrganizationPlanCacheKey(organizationId: string): string {
	return `${EFFECTIVE_LIMIT_CACHE_ORIGIN}/org-plan/${encodeURIComponent(organizationId)}`;
}

export function buildProjectOrganizationCacheKey(projectId: string): string {
	return `${EFFECTIVE_LIMIT_CACHE_ORIGIN}/project-org/${encodeURIComponent(projectId)}`;
}

export function buildEntitlementCacheKey(scopeId: string, key: string): string {
	return `${EFFECTIVE_LIMIT_CACHE_ORIGIN}/entitlement/${encodeURIComponent(scopeId)}/${encodeURIComponent(key)}`;
}

export interface ResolvedOrgLimits {
	maxRunningContainers: number;
	maxProjects: number;
	maxMembers: number;
	maxPendingInvitations: number;
	storageQuotaBytes: number;
}

export interface ResolvedUserLimits {
	maxFreeOrganizations: number;
}

export interface ResolvedProjectLimits {
	storageQuotaBytes: number;
}

export const EFFECTIVE_LIMIT_USER_MAX_FREE_ORGANIZATIONS = 'user:maxFreeOrganizations';
export const EFFECTIVE_LIMIT_ORG_MAX_PROJECTS = 'org:maxProjects';
export const EFFECTIVE_LIMIT_ORG_MAX_MEMBERS = 'org:maxMembers';
export const EFFECTIVE_LIMIT_ORG_MAX_RUNNING_CONTAINERS = 'org:maxRunningContainers';
export const EFFECTIVE_LIMIT_ORG_MAX_PENDING_INVITATIONS = 'org:maxPendingInvitations';
export const EFFECTIVE_LIMIT_ORG_STORAGE_QUOTA_BYTES = 'org:storageQuotaBytes';
export const EFFECTIVE_LIMIT_PROJECT_STORAGE_QUOTA_BYTES = 'project:storageQuotaBytes';

export type EffectiveLimitKey =
	| typeof EFFECTIVE_LIMIT_USER_MAX_FREE_ORGANIZATIONS
	| typeof EFFECTIVE_LIMIT_ORG_MAX_PROJECTS
	| typeof EFFECTIVE_LIMIT_ORG_MAX_MEMBERS
	| typeof EFFECTIVE_LIMIT_ORG_MAX_RUNNING_CONTAINERS
	| typeof EFFECTIVE_LIMIT_ORG_MAX_PENDING_INVITATIONS
	| typeof EFFECTIVE_LIMIT_ORG_STORAGE_QUOTA_BYTES
	| typeof EFFECTIVE_LIMIT_PROJECT_STORAGE_QUOTA_BYTES;

export type UserEffectiveLimitKey = Extract<EffectiveLimitKey, `user:${string}`>;
export type OrgEffectiveLimitKey = Extract<EffectiveLimitKey, `org:${string}`>;
export type ProjectEffectiveLimitKey = Extract<EffectiveLimitKey, `project:${string}`>;

export interface UserEffectiveLimitContext {
	kind: 'user';
	userEntitlements: Map<string, EntitlementValue>;
}

export interface OrgEffectiveLimitContext {
	kind: 'org';
	plan: string;
	orgEntitlements: Map<string, EntitlementValue>;
}

export interface ProjectEffectiveLimitContext {
	kind: 'project';
	plan: string;
	orgEntitlements: Map<string, EntitlementValue>;
	projectEntitlements: Map<string, EntitlementValue>;
}

export type EffectiveLimitContext = UserEffectiveLimitContext | OrgEffectiveLimitContext | ProjectEffectiveLimitContext;

type EffectiveLimitContextForKey<TKey extends EffectiveLimitKey> = TKey extends UserEffectiveLimitKey
	? UserEffectiveLimitContext
	: TKey extends OrgEffectiveLimitKey
		? OrgEffectiveLimitContext
		: ProjectEffectiveLimitContext;

interface EffectiveLimitDefinition<TKey extends EffectiveLimitKey> {
	kind: EffectiveLimitContextForKey<TKey>['kind'];
	resolve: (context: EffectiveLimitContextForKey<TKey>) => number;
}

type EffectiveLimitRegistry = {
	[TKey in EffectiveLimitKey]: EffectiveLimitDefinition<TKey>;
};

type OrgPlanLimitKey = keyof ReturnType<typeof getOrgLimits>;

function getPlanLimit(plan: string, key: OrgPlanLimitKey): number {
	return getOrgLimits(plan)[key];
}

function getNumber(map: Map<string, EntitlementValue>, key: string): number | undefined {
	const entry = map.get(key);
	if (entry?.valueType === 'number') {
		return entry.value;
	}
	return undefined;
}

function resolveNumberEntitlement(entitlements: Map<string, EntitlementValue>, key: string, fallback: number): number {
	return getNumber(entitlements, key) ?? fallback;
}

const EFFECTIVE_LIMIT_REGISTRY: EffectiveLimitRegistry = {
	[EFFECTIVE_LIMIT_ORG_MAX_RUNNING_CONTAINERS]: {
		kind: 'org',
		resolve: (context) => {
			const value = getNumber(context.orgEntitlements, ENTITLEMENT_ORG_MAX_RUNNING_CONTAINERS);
			return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : getPlanLimit(context.plan, 'maxRunningContainers');
		},
	},
	[EFFECTIVE_LIMIT_USER_MAX_FREE_ORGANIZATIONS]: {
		kind: 'user',
		resolve: (context) => resolveNumberEntitlement(context.userEntitlements, ENTITLEMENT_USER_MAX_FREE_ORGS, DEFAULT_MAX_FREE_ORGS),
	},
	[EFFECTIVE_LIMIT_ORG_MAX_PROJECTS]: {
		kind: 'org',
		resolve: (context) =>
			resolveNumberEntitlement(context.orgEntitlements, ENTITLEMENT_ORG_MAX_PROJECTS, getPlanLimit(context.plan, 'maxProjects')),
	},
	[EFFECTIVE_LIMIT_ORG_MAX_MEMBERS]: {
		kind: 'org',
		resolve: (context) =>
			resolveNumberEntitlement(context.orgEntitlements, ENTITLEMENT_ORG_MAX_MEMBERS, getPlanLimit(context.plan, 'maxMembers')),
	},
	[EFFECTIVE_LIMIT_ORG_MAX_PENDING_INVITATIONS]: {
		kind: 'org',
		resolve: (context) => getPlanLimit(context.plan, 'maxPendingInvitations'),
	},
	[EFFECTIVE_LIMIT_ORG_STORAGE_QUOTA_BYTES]: {
		kind: 'org',
		resolve: (context) =>
			resolveNumberEntitlement(
				context.orgEntitlements,
				ENTITLEMENT_ORG_STORAGE_QUOTA_BYTES,
				getPlanLimit(context.plan, 'storageQuotaBytes'),
			),
	},
	[EFFECTIVE_LIMIT_PROJECT_STORAGE_QUOTA_BYTES]: {
		kind: 'project',
		resolve: (context) => {
			const planStorageQuota = getPlanLimit(context.plan, 'storageQuotaBytes');
			const orgStorageQuota = resolveNumberEntitlement(context.orgEntitlements, ENTITLEMENT_ORG_STORAGE_QUOTA_BYTES, planStorageQuota);
			return resolveNumberEntitlement(context.projectEntitlements, ENTITLEMENT_PROJECT_STORAGE_QUOTA_BYTES, orgStorageQuota);
		},
	},
};

export function resolveEffectiveLimit<TKey extends EffectiveLimitKey>(key: TKey, context: EffectiveLimitContextForKey<TKey>): number {
	return EFFECTIVE_LIMIT_REGISTRY[key].resolve(context);
}

export function resolveEffectiveLimits(context: UserEffectiveLimitContext): ResolvedUserLimits;
export function resolveEffectiveLimits(context: OrgEffectiveLimitContext): ResolvedOrgLimits;
export function resolveEffectiveLimits(context: ProjectEffectiveLimitContext): ResolvedProjectLimits;
export function resolveEffectiveLimits(context: EffectiveLimitContext): ResolvedUserLimits | ResolvedOrgLimits | ResolvedProjectLimits {
	switch (context.kind) {
		case 'user': {
			return {
				maxFreeOrganizations: resolveEffectiveLimit(EFFECTIVE_LIMIT_USER_MAX_FREE_ORGANIZATIONS, context),
			};
		}
		case 'org': {
			return {
				maxRunningContainers: resolveEffectiveLimit(EFFECTIVE_LIMIT_ORG_MAX_RUNNING_CONTAINERS, context),
				maxProjects: resolveEffectiveLimit(EFFECTIVE_LIMIT_ORG_MAX_PROJECTS, context),
				maxMembers: resolveEffectiveLimit(EFFECTIVE_LIMIT_ORG_MAX_MEMBERS, context),
				maxPendingInvitations: resolveEffectiveLimit(EFFECTIVE_LIMIT_ORG_MAX_PENDING_INVITATIONS, context),
				storageQuotaBytes: resolveEffectiveLimit(EFFECTIVE_LIMIT_ORG_STORAGE_QUOTA_BYTES, context),
			};
		}
		case 'project': {
			return {
				storageQuotaBytes: resolveEffectiveLimit(EFFECTIVE_LIMIT_PROJECT_STORAGE_QUOTA_BYTES, context),
			};
		}
	}
}

export function resolveOrgLimits(plan: string, entitlements: Map<string, EntitlementValue>): ResolvedOrgLimits {
	return resolveEffectiveLimits({ kind: 'org', plan, orgEntitlements: entitlements });
}

export function resolveUserLimits(entitlements: Map<string, EntitlementValue>): ResolvedUserLimits {
	return resolveEffectiveLimits({ kind: 'user', userEntitlements: entitlements });
}

export function resolveProjectStorageQuota(
	plan: string,
	orgEntitlements: Map<string, EntitlementValue>,
	projectEntitlements: Map<string, EntitlementValue>,
): number {
	return resolveEffectiveLimit(EFFECTIVE_LIMIT_PROJECT_STORAGE_QUOTA_BYTES, {
		kind: 'project',
		plan,
		orgEntitlements,
		projectEntitlements,
	});
}
