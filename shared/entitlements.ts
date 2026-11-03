export type EntitlementValueType = 'number' | 'boolean' | 'string';

/**
 * A typed entitlement value. The discriminator `valueType` determines
 * how `value` (stored as TEXT in SQLite) is interpreted.
 */
export type EntitlementValue =
	{ valueType: 'number'; value: number } | { valueType: 'boolean'; value: boolean } | { valueType: 'string'; value: string };

export function serializeEntitlementValue(typed: EntitlementValue): string {
	return String(typed.value);
}

export function deserializeEntitlementValue(raw: string, valueType: EntitlementValueType): EntitlementValue {
	switch (valueType) {
		case 'number': {
			return { valueType: 'number', value: Number(raw) };
		}
		case 'boolean': {
			return { valueType: 'boolean', value: raw === 'true' };
		}
		case 'string': {
			return { valueType: 'string', value: raw };
		}
	}
}

/**
 * Org-scoped entitlement keys.
 * Assigned to an organization to override its plan defaults.
 */
export const ENTITLEMENT_ORG_MAX_PROJECTS = 'org:max_projects' as const;
export const ENTITLEMENT_ORG_MAX_MEMBERS = 'org:max_members' as const;
export const ENTITLEMENT_ORG_MAX_RUNNING_CONTAINERS = 'org:max_running_containers';
export const ENTITLEMENT_ORG_STORAGE_QUOTA_BYTES = 'org:storage_quota_bytes' as const;

/**
 * User-scoped entitlement keys.
 * Assigned to a user to override global defaults.
 */
export const ENTITLEMENT_USER_MAX_FREE_ORGS = 'user:max_free_orgs' as const;

/**
 * Project-scoped entitlement keys.
 * Assigned to a project (scopeId = projectId) to override org/plan defaults.
 */
export const ENTITLEMENT_PROJECT_STORAGE_QUOTA_BYTES = 'project:storage_quota_bytes' as const;

export type EntitlementKey =
	| typeof ENTITLEMENT_ORG_MAX_PROJECTS
	| typeof ENTITLEMENT_ORG_MAX_MEMBERS
	| typeof ENTITLEMENT_ORG_MAX_RUNNING_CONTAINERS
	| typeof ENTITLEMENT_ORG_STORAGE_QUOTA_BYTES
	| typeof ENTITLEMENT_USER_MAX_FREE_ORGS
	| typeof ENTITLEMENT_PROJECT_STORAGE_QUOTA_BYTES;

export type OrgEntitlementKey = Extract<EntitlementKey, `org:${string}`>;
export type UserEntitlementKey = Extract<EntitlementKey, `user:${string}`>;
export type ProjectEntitlementKey = Extract<EntitlementKey, `project:${string}`>;

type EntitlementRegistryEntry = {
	valueType: EntitlementValueType;
	description: string;
};

function numberEntitlement(description: string): EntitlementRegistryEntry {
	return { valueType: 'number', description };
}

/**
 * All valid entitlement keys with their expected value types.
 * Used for validation and documentation.
 */
export const ENTITLEMENT_REGISTRY: Record<EntitlementKey, EntitlementRegistryEntry> = {
	[ENTITLEMENT_ORG_MAX_PROJECTS]: numberEntitlement('Maximum active projects per organization'),
	[ENTITLEMENT_ORG_MAX_MEMBERS]: numberEntitlement('Maximum members per organization'),
	[ENTITLEMENT_ORG_MAX_RUNNING_CONTAINERS]: numberEntitlement('Maximum simultaneously running containers per organization'),
	[ENTITLEMENT_ORG_STORAGE_QUOTA_BYTES]: numberEntitlement('Maximum object storage bytes per project (org default)'),
	[ENTITLEMENT_USER_MAX_FREE_ORGS]: numberEntitlement('Maximum free organizations a user can belong to'),
	[ENTITLEMENT_PROJECT_STORAGE_QUOTA_BYTES]: numberEntitlement('Maximum object storage bytes for this project (overrides org)'),
};

export function isValidEntitlementKey(key: string): key is EntitlementKey {
	return key in ENTITLEMENT_REGISTRY;
}

export function getEntitlementScope(key: EntitlementKey): 'org' | 'user' | 'project' {
	if (key.startsWith('org:')) return 'org';
	if (key.startsWith('project:')) return 'project';
	return 'user';
}

export interface EntitlementRecord {
	id: string;
	scopeId: string;
	key: EntitlementKey;
	valueType: EntitlementValueType;
	value: string;
	note: string | undefined;
	createdAt: Date;
	updatedAt: Date;
}

export type EntitlementMapInput = Pick<EntitlementRecord, 'key' | 'valueType' | 'value'>;

/**
 * Build a lookup map from raw entitlement DB rows.
 * Only includes rows whose key/valueType match the registry.
 */
export function toEntitlementMap(rows: EntitlementMapInput[]): Map<string, EntitlementValue> {
	const map = new Map<string, EntitlementValue>();
	for (const row of rows) {
		if (!isValidEntitlementKey(row.key)) {
			continue;
		}

		const expectedType = ENTITLEMENT_REGISTRY[row.key].valueType;
		if (row.valueType !== expectedType) {
			continue;
		}

		map.set(row.key, deserializeEntitlementValue(row.value, expectedType));
	}
	return map;
}
