import { describe, expect, it } from 'vitest';

import {
	ENTITLEMENT_ORG_MAX_MEMBERS,
	ENTITLEMENT_ORG_MAX_PROJECTS,
	ENTITLEMENT_ORG_STORAGE_QUOTA_BYTES,
	ENTITLEMENT_PROJECT_STORAGE_QUOTA_BYTES,
	ENTITLEMENT_USER_MAX_FREE_ORGS,
	toEntitlementMap,
} from './entitlements';
import {
	DEFAULT_MAX_FREE_ORGS,
	EFFECTIVE_LIMIT_ORG_MAX_MEMBERS,
	EFFECTIVE_LIMIT_ORG_MAX_PROJECTS,
	EFFECTIVE_LIMIT_ORG_STORAGE_QUOTA_BYTES,
	EFFECTIVE_LIMIT_PROJECT_STORAGE_QUOTA_BYTES,
	EFFECTIVE_LIMIT_USER_MAX_FREE_ORGANIZATIONS,
	resolveEffectiveLimit,
	resolveEffectiveLimits,
	resolveOrgLimits,
	resolveProjectStorageQuota,
	resolveUserLimits,
} from './limits';

import type { OrgEffectiveLimitContext, ProjectEffectiveLimitContext, UserEffectiveLimitContext } from './limits';

describe('resolveProjectStorageQuota', () => {
	const FREE_DEFAULT = 50 * 1024 * 1024;
	const PRO_DEFAULT = 500 * 1024 * 1024;

	it('returns plan default when no entitlements exist', () => {
		const orgEntitlements = toEntitlementMap([]);
		const projectEntitlements = toEntitlementMap([]);

		expect(resolveProjectStorageQuota('free', orgEntitlements, projectEntitlements)).toBe(FREE_DEFAULT);
		expect(resolveProjectStorageQuota('pro', orgEntitlements, projectEntitlements)).toBe(PRO_DEFAULT);
	});

	it('returns org entitlement override when set', () => {
		const orgEntitlements = toEntitlementMap([{ key: ENTITLEMENT_ORG_STORAGE_QUOTA_BYTES, valueType: 'number', value: '100000000' }]);
		const projectEntitlements = toEntitlementMap([]);

		expect(resolveProjectStorageQuota('free', orgEntitlements, projectEntitlements)).toBe(100_000_000);
	});

	it('returns project entitlement override when set, even if org override exists', () => {
		const orgEntitlements = toEntitlementMap([{ key: ENTITLEMENT_ORG_STORAGE_QUOTA_BYTES, valueType: 'number', value: '100000000' }]);
		const projectEntitlements = toEntitlementMap([
			{ key: ENTITLEMENT_PROJECT_STORAGE_QUOTA_BYTES, valueType: 'number', value: '200000000' },
		]);

		expect(resolveProjectStorageQuota('free', orgEntitlements, projectEntitlements)).toBe(200_000_000);
	});

	it('project entitlement overrides plan default even without org entitlement', () => {
		const orgEntitlements = toEntitlementMap([]);
		const projectEntitlements = toEntitlementMap([{ key: ENTITLEMENT_PROJECT_STORAGE_QUOTA_BYTES, valueType: 'number', value: '999' }]);

		expect(resolveProjectStorageQuota('enterprise', orgEntitlements, projectEntitlements)).toBe(999);
	});

	it('falls back to free plan for unknown plan strings', () => {
		const orgEntitlements = toEntitlementMap([]);
		const projectEntitlements = toEntitlementMap([]);

		expect(resolveProjectStorageQuota('nonexistent', orgEntitlements, projectEntitlements)).toBe(FREE_DEFAULT);
	});
});

describe('resolveOrgLimits', () => {
	it('includes plan-based pending invitation limits', () => {
		const limits = resolveOrgLimits('free', toEntitlementMap([]));

		expect(limits.maxMembers).toBe(10);
		expect(limits.maxPendingInvitations).toBe(10);
	});
});

describe('resolveEffectiveLimit', () => {
	it('resolves user limits from the generic API', () => {
		const context: UserEffectiveLimitContext = {
			kind: 'user',
			userEntitlements: toEntitlementMap([{ key: ENTITLEMENT_USER_MAX_FREE_ORGS, valueType: 'number', value: '5' }]),
		};

		expect(resolveEffectiveLimit(EFFECTIVE_LIMIT_USER_MAX_FREE_ORGANIZATIONS, context)).toBe(5);
	});

	it('resolves org limits from plan defaults and entitlement overrides', () => {
		const context: OrgEffectiveLimitContext = {
			kind: 'org',
			plan: 'pro',
			orgEntitlements: toEntitlementMap([
				{ key: ENTITLEMENT_ORG_MAX_PROJECTS, valueType: 'number', value: '42' },
				{ key: ENTITLEMENT_ORG_MAX_MEMBERS, valueType: 'number', value: '123' },
				{ key: ENTITLEMENT_ORG_STORAGE_QUOTA_BYTES, valueType: 'number', value: '777' },
			]),
		};

		expect(resolveEffectiveLimit(EFFECTIVE_LIMIT_ORG_MAX_PROJECTS, context)).toBe(42);
		expect(resolveEffectiveLimit(EFFECTIVE_LIMIT_ORG_MAX_MEMBERS, context)).toBe(123);
		expect(resolveEffectiveLimit(EFFECTIVE_LIMIT_ORG_STORAGE_QUOTA_BYTES, context)).toBe(777);
	});

	it('prefers project overrides over org overrides for project limits', () => {
		const context: ProjectEffectiveLimitContext = {
			kind: 'project',
			plan: 'free',
			orgEntitlements: toEntitlementMap([{ key: ENTITLEMENT_ORG_STORAGE_QUOTA_BYTES, valueType: 'number', value: '1000' }]),
			projectEntitlements: toEntitlementMap([{ key: ENTITLEMENT_PROJECT_STORAGE_QUOTA_BYTES, valueType: 'number', value: '2000' }]),
		};

		expect(resolveEffectiveLimit(EFFECTIVE_LIMIT_PROJECT_STORAGE_QUOTA_BYTES, context)).toBe(2000);
	});
});

describe('resolveEffectiveLimits', () => {
	it('resolves all org limits from a generic org context', () => {
		const context: OrgEffectiveLimitContext = {
			kind: 'org',
			plan: 'pro',
			orgEntitlements: toEntitlementMap([{ key: ENTITLEMENT_ORG_MAX_PROJECTS, valueType: 'number', value: '99' }]),
		};

		expect(resolveEffectiveLimits(context)).toEqual({
			maxProjects: 99,
			maxRunningContainers: 10,
			maxMembers: 25,
			maxPendingInvitations: 25,
			storageQuotaBytes: 500 * 1024 * 1024,
		});
	});

	it('resolves project limits from a generic project context', () => {
		const context: ProjectEffectiveLimitContext = {
			kind: 'project',
			plan: 'free',
			orgEntitlements: toEntitlementMap([{ key: ENTITLEMENT_ORG_STORAGE_QUOTA_BYTES, valueType: 'number', value: '1000' }]),
			projectEntitlements: toEntitlementMap([]),
		};

		expect(resolveEffectiveLimits(context)).toEqual({
			storageQuotaBytes: 1000,
		});
	});
});

describe('resolveUserLimits', () => {
	it('uses the default free organization cap', () => {
		expect(resolveUserLimits(toEntitlementMap([])).maxFreeOrganizations).toBe(DEFAULT_MAX_FREE_ORGS);
	});

	it('lets user entitlements override the plan default', () => {
		const entitlements = toEntitlementMap([{ key: ENTITLEMENT_USER_MAX_FREE_ORGS, valueType: 'number', value: '5' }]);

		expect(resolveUserLimits(entitlements).maxFreeOrganizations).toBe(5);
	});

	it('ignores rows with the wrong value type', () => {
		const entitlements = toEntitlementMap([{ key: ENTITLEMENT_USER_MAX_FREE_ORGS, valueType: 'string', value: '5' }]);

		expect(resolveUserLimits(entitlements).maxFreeOrganizations).toBe(DEFAULT_MAX_FREE_ORGS);
	});
});
