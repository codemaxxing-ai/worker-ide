import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const user = sqliteTable('user', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	email: text('email').notNull().unique(),
	emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
	image: text('image'),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
	deletedAt: integer('deleted_at', { mode: 'timestamp' }),
	bannedAt: integer('banned_at', { mode: 'timestamp' }),
	role: text('role').notNull().default('user'),
	banned: integer('banned', { mode: 'boolean' }).default(false),
	banReason: text('ban_reason'),
	banExpires: integer('ban_expires', { mode: 'timestamp' }),
});

export const session = sqliteTable(
	'session',
	{
		id: text('id').primaryKey(),
		expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
		authenticatedAt: integer('authenticated_at', { mode: 'timestamp' }),
		token: text('token').notNull().unique(),
		createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
		ipAddress: text('ip_address'),
		userAgent: text('user_agent'),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		activeOrganizationId: text('active_organization_id'),
		impersonatedBy: text('impersonated_by'),
	},
	(table) => [index('session_user_id_idx').on(table.userId)],
);

export const account = sqliteTable(
	'account',
	{
		id: text('id').primaryKey(),
		accountId: text('account_id').notNull(),
		providerId: text('provider_id').notNull(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		accessToken: text('access_token'),
		refreshToken: text('refresh_token'),
		idToken: text('id_token'),
		accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp' }),
		refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp' }),
		scope: text('scope'),
		password: text('password'),
		createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
	},
	(table) => [index('account_user_id_idx').on(table.userId), index('account_provider_account_idx').on(table.providerId, table.accountId)],
);

export const verification = sqliteTable(
	'verification',
	{
		id: text('id').primaryKey(),
		identifier: text('identifier').notNull(),
		value: text('value').notNull(),
		expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
		createdAt: integer('created_at', { mode: 'timestamp' }),
		updatedAt: integer('updated_at', { mode: 'timestamp' }),
	},
	(table) => [index('verification_identifier_idx').on(table.identifier)],
);

export const organization = sqliteTable('organization', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	slug: text('slug').notNull().unique(),
	logo: text('logo'),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
	metadata: text('metadata'),
	plan: text('plan').notNull().default('free'),
	deletedAt: integer('deleted_at', { mode: 'timestamp' }),
	bannedAt: integer('banned_at', { mode: 'timestamp' }),
});

export const member = sqliteTable(
	'member',
	{
		id: text('id').primaryKey(),
		organizationId: text('organization_id')
			.notNull()
			.references(() => organization.id, { onDelete: 'cascade' }),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		role: text('role').notNull().default('member'),
		createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
	},
	(table) => [index('member_org_user_idx').on(table.organizationId, table.userId), index('member_user_id_idx').on(table.userId)],
);

export const invitation = sqliteTable(
	'invitation',
	{
		id: text('id').primaryKey(),
		organizationId: text('organization_id')
			.notNull()
			.references(() => organization.id, { onDelete: 'cascade' }),
		email: text('email').notNull(),
		role: text('role'),
		status: text('status').notNull().default('pending'),
		expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
		inviterId: text('inviter_id').references(() => user.id, { onDelete: 'set null' }),
		createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
	},
	(table) => [index('invitation_org_id_idx').on(table.organizationId), index('invitation_email_idx').on(table.email)],
);

export const project = sqliteTable(
	'project',
	{
		id: text('id').primaryKey(),
		organizationId: text('organization_id').notNull(),
		durableObjectHexId: text('durable_object_hex_id').notNull(),
		name: text('name').notNull(),
		previewVisibility: text('preview_visibility').notNull().default('public'),
		createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
		deletedAt: integer('deleted_at', { mode: 'timestamp' }),
		deletedViaType: text('deleted_via_type'),
		deletedViaId: text('deleted_via_id'),
		bannedAt: integer('banned_at', { mode: 'timestamp' }),
		lastActivityAt: integer('last_activity_at', { mode: 'timestamp' }),
	},
	(table) => [
		index('project_org_deleted_idx').on(table.organizationId, table.deletedAt),
		index('project_deleted_created_idx').on(table.deletedAt, table.createdAt),
		index('project_banned_idx').on(table.bannedAt),
		index('project_last_activity_idx').on(table.lastActivityAt),
	],
);

export const userProjectAccess = sqliteTable(
	'user_project_access',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		projectId: text('project_id')
			.notNull()
			.references(() => project.id, { onDelete: 'cascade' }),
		lastAccessedAt: integer('last_accessed_at', { mode: 'timestamp' }).notNull(),
	},
	(table) => [
		uniqueIndex('user_project_access_user_project_idx').on(table.userId, table.projectId),
		index('user_project_access_user_accessed_idx').on(table.userId, table.lastAccessedAt),
	],
);

export const userProjectFavorite = sqliteTable(
	'user_project_favorite',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		projectId: text('project_id')
			.notNull()
			.references(() => project.id, { onDelete: 'cascade' }),
		createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
	},
	(table) => [
		uniqueIndex('user_project_favorite_user_project_idx').on(table.userId, table.projectId),
		index('user_project_favorite_user_created_idx').on(table.userId, table.createdAt),
	],
);

export const projectTransfer = sqliteTable(
	'project_transfer',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => project.id, { onDelete: 'cascade' }),
		sourceOrganizationId: text('source_organization_id').notNull(),
		targetOrganizationId: text('target_organization_id').notNull(),
		initiatedByUserId: text('initiated_by_user_id').references(() => user.id, { onDelete: 'set null' }),
		status: text('status').notNull().default('pending'),
		createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
		resolvedAt: integer('resolved_at', { mode: 'timestamp' }),
		resolvedByUserId: text('resolved_by_user_id').references(() => user.id, { onDelete: 'set null' }),
	},
	(table) => [
		index('project_transfer_status_target_idx').on(table.status, table.targetOrganizationId),
		index('project_transfer_status_source_idx').on(table.status, table.sourceOrganizationId),
		index('project_transfer_project_status_idx').on(table.projectId, table.status),
	],
);

export const subscription = sqliteTable(
	'subscription',
	{
		id: text('id').primaryKey(),
		organizationId: text('organization_id')
			.notNull()
			.references(() => organization.id, { onDelete: 'cascade' }),
		plan: text('plan').notNull().default('free'),
		status: text('status').notNull().default('active'),
		currentPeriodStart: integer('current_period_start', { mode: 'timestamp' }),
		currentPeriodEnd: integer('current_period_end', { mode: 'timestamp' }),
		cancelAtPeriodEnd: integer('cancel_at_period_end', { mode: 'boolean' }).notNull().default(false),
		externalId: text('external_id'),
		externalCustomerId: text('external_customer_id'),
		createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
	},
	(table) => [index('subscription_org_id_idx').on(table.organizationId), index('subscription_external_id_idx').on(table.externalId)],
);

export const billingEvent = sqliteTable(
	'billing_event',
	{
		id: text('id').primaryKey(),
		organizationId: text('organization_id').notNull(),
		type: text('type').notNull(),
		metadata: text('metadata'),
		createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
	},
	(table) => [index('billing_event_org_id_idx').on(table.organizationId), index('billing_event_type_idx').on(table.type)],
);

export const creditLedger = sqliteTable(
	'credit_ledger',
	{
		id: text('id').primaryKey(),
		organizationId: text('organization_id')
			.notNull()
			.references(() => organization.id, { onDelete: 'cascade' }),
		amount: integer('amount').notNull(),
		balance: integer('balance').notNull(),
		type: text('type').notNull(),
		description: text('description').notNull(),
		referenceId: text('reference_id'),
		createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
	},
	(table) => [
		index('credit_ledger_org_id_idx').on(table.organizationId),
		index('credit_ledger_type_idx').on(table.type),
		index('credit_ledger_reference_idx').on(table.referenceId),
	],
);

export const entitlement = sqliteTable(
	'entitlement',
	{
		id: text('id').primaryKey(),
		scopeId: text('scope_id').notNull(),
		key: text('key').notNull(),
		valueType: text('value_type').notNull(),
		value: text('value').notNull(),
		note: text('note'),
		createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
	},
	(table) => [uniqueIndex('entitlement_scope_key_idx').on(table.scopeId, table.key), index('entitlement_scope_id_idx').on(table.scopeId)],
);

/**
 * Per-user Cloudflare OAuth connection, used to deploy Workers into the user's
 * own Cloudflare account. Replaces the legacy "paste an API token" flow.
 *
 * Access and refresh tokens are stored encrypted (AES-GCM); see
 * `worker/lib/cloudflare-oauth-crypto.ts`.
 */
export const cloudflareConnection = sqliteTable(
	'cloudflare_connection',
	{
		userId: text('user_id')
			.primaryKey()
			.references(() => user.id, { onDelete: 'cascade' }),
		accessTokenEncrypted: text('access_token_encrypted').notNull(),
		refreshTokenEncrypted: text('refresh_token_encrypted'),
		accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp' }),
		scope: text('scope'),
		cloudflareEmail: text('cloudflare_email'),
		createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
	},
	(table) => [index('cloudflare_connection_user_id_idx').on(table.userId)],
);

/**
 * An unclaimed Cloudflare temporary account used only for the 60-minute claim
 * window. Its deploy token is encrypted at rest and never sent to the client.
 */
export const cloudflareTemporaryAccount = sqliteTable(
	'cloudflare_temporary_account',
	{
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		projectId: text('project_id')
			.notNull()
			.references(() => project.id, { onDelete: 'cascade' }),
		accountId: text('account_id').notNull(),
		accessTokenEncrypted: text('access_token_encrypted').notNull(),
		claimUrl: text('claim_url').notNull(),
		expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
		createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.userId, table.projectId] }),
		index('cloudflare_temporary_account_expires_at_idx').on(table.expiresAt),
	],
);

export const userPreference = sqliteTable(
	'user_preference',
	{
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		key: text('key').notNull(),
		value: text('value').notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
	},
	(table) => [primaryKey({ columns: [table.userId, table.key] }), index('user_preference_user_id_idx').on(table.userId)],
);

export type UserRow = typeof user.$inferSelect;
export type SessionRow = typeof session.$inferSelect;
export type AccountRow = typeof account.$inferSelect;
export type OrganizationRow = typeof organization.$inferSelect;
export type MemberRow = typeof member.$inferSelect;
export type InvitationRow = typeof invitation.$inferSelect;
export type ProjectRow = typeof project.$inferSelect;
export type ProjectInsert = typeof project.$inferInsert;
export type UserProjectAccessRow = typeof userProjectAccess.$inferSelect;
export type UserProjectAccessInsert = typeof userProjectAccess.$inferInsert;
export type UserProjectFavoriteRow = typeof userProjectFavorite.$inferSelect;
export type UserProjectFavoriteInsert = typeof userProjectFavorite.$inferInsert;
export type ProjectTransferRow = typeof projectTransfer.$inferSelect;
export type ProjectTransferInsert = typeof projectTransfer.$inferInsert;
export type SubscriptionRow = typeof subscription.$inferSelect;
export type SubscriptionInsert = typeof subscription.$inferInsert;
export type BillingEventRow = typeof billingEvent.$inferSelect;
export type BillingEventInsert = typeof billingEvent.$inferInsert;
export type CreditLedgerRow = typeof creditLedger.$inferSelect;
export type CreditLedgerInsert = typeof creditLedger.$inferInsert;
export type EntitlementRow = typeof entitlement.$inferSelect;
export type EntitlementInsert = typeof entitlement.$inferInsert;
export type UserPreferenceRow = typeof userPreference.$inferSelect;
export type UserPreferenceInsert = typeof userPreference.$inferInsert;
export type CloudflareConnectionRow = typeof cloudflareConnection.$inferSelect;
export type CloudflareConnectionInsert = typeof cloudflareConnection.$inferInsert;
