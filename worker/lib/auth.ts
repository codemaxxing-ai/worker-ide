import { betterAuth, APIError } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin, organization } from 'better-auth/plugins';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import {
	ADMIN_PLUGIN_OPTIONS,
	AUTH_BASE_PATH,
	IP_ADDRESS_HEADERS,
	INVITATION_EXPIRES_IN_SECONDS,
	PLAN_FREE,
	SESSION_COOKIE_CACHE,
} from '@shared/constants';
import { EFFECTIVE_LIMIT_ORG_MAX_MEMBERS, EFFECTIVE_LIMIT_ORG_MAX_PENDING_INVITATIONS } from '@shared/limits';

import { trackAuthEvent } from './analytics';
import { getEffectiveLimit } from './limits';
import { shouldBlockOrganizationCreate } from './organization-limits';
import { sessionReauthentication } from './session-reauthentication';
import * as schema from '../db/auth-schema';

interface AuthEnvironment {
	DB: D1Database;
	BETTER_AUTH_SECRET: string;
	GITHUB_CLIENT_ID?: string;
	GITHUB_CLIENT_SECRET?: string;
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
}

export function createAuth(environment: AuthEnvironment, baseUrl: string, request?: Request) {
	const database = drizzle(environment.DB, { schema });
	const socialProviders = {
		...(environment.GITHUB_CLIENT_ID && environment.GITHUB_CLIENT_SECRET
			? {
					github: {
						clientId: environment.GITHUB_CLIENT_ID,
						clientSecret: environment.GITHUB_CLIENT_SECRET,
					},
				}
			: {}),
		...(environment.GOOGLE_CLIENT_ID && environment.GOOGLE_CLIENT_SECRET
			? {
					google: {
						clientId: environment.GOOGLE_CLIENT_ID,
						clientSecret: environment.GOOGLE_CLIENT_SECRET,
					},
				}
			: {}),
	};

	return betterAuth({
		database: drizzleAdapter(database, {
			provider: 'sqlite',
			schema,
		}),
		baseURL: baseUrl,
		basePath: AUTH_BASE_PATH,
		secret: environment.BETTER_AUTH_SECRET,
		socialProviders,
		account: {
			accountLinking: {
				enabled: true,
				trustedProviders: [],
				allowDifferentEmails: true,
			},
		},
		onAPIError: {
			errorURL: '/',
		},
		emailVerification: {
			sendVerificationEmail: async (data) => {
				try {
					await env.EMAIL.sendEmailVerification({
						to: data.user.email,
						userName: data.user.name,
						verificationUrl: data.url,
					});
				} catch (error) {
					console.error('Failed to send verification email:', error);
				}
			},
		},
		emailAndPassword: {
			enabled: true,
			requireEmailVerification: true,
			sendResetPassword: async (data) => {
				try {
					await env.EMAIL.sendPasswordReset({
						to: data.user.email,
						userName: data.user.name,
						resetUrl: data.url,
					});
				} catch (error) {
					console.error('Failed to send password reset email:', error);
				}
			},
			// Include admin plugin fields in the synthetic user response so
			// fake sign-up responses are indistinguishable from real ones
			// (email enumeration protection).
			customSyntheticUser: ({ coreFields, additionalFields, id }) => ({
				...coreFields,
				role: 'user',

				banned: false,
				// eslint-disable-next-line unicorn/no-null -- better-auth expects null for these fields
				banReason: null,
				// eslint-disable-next-line unicorn/no-null -- better-auth expects null for these fields
				banExpires: null,
				...additionalFields,
				id,
			}),
		},
		plugins: [
			sessionReauthentication(environment.DB, Object.keys(socialProviders)),
			admin(ADMIN_PLUGIN_OPTIONS),
			organization({
				organizationLimit: async (user) => shouldBlockOrganizationCreate(drizzle(environment.DB, { schema }), user.id),

				// Dynamic membership limit: plan-based + org entitlements
				membershipLimit: async (_user, organizationRecord) => {
					return getEffectiveLimit(drizzle(environment.DB, { schema }), {
						key: EFFECTIVE_LIMIT_ORG_MAX_MEMBERS,
						organizationId: organizationRecord.id,
					});
				},

				// Dynamic invitation limit: plan-based + org entitlements
				invitationLimit: async ({ organization: organizationRecord }) => {
					return getEffectiveLimit(drizzle(environment.DB, { schema }), {
						key: EFFECTIVE_LIMIT_ORG_MAX_PENDING_INVITATIONS,
						organizationId: organizationRecord.id,
					});
				},
				schema: {
					organization: {
						additionalFields: {
							plan: {
								type: 'string',
								defaultValue: 'free',
								required: false,
								input: false,
							},
							deletedAt: {
								type: 'date',
								required: false,
								input: false,
							},
							bannedAt: {
								type: 'date',
								required: false,
								input: false,
							},
						},
					},
				},
				invitationExpiresIn: INVITATION_EXPIRES_IN_SECONDS,
				sendInvitationEmail: async (data) => {
					const acceptUrl = `${baseUrl}/api/auth/organization/accept-invitation?id=${data.id}`;
					try {
						await env.EMAIL.sendOrgInvitation({
							to: data.email,
							inviterName: data.inviter.user.name,
							organizationName: data.organization.name,
							role: data.role,
							acceptUrl,
						});
					} catch (error) {
						console.error('Failed to send invitation email:', error);
					}
					trackAuthEvent({ userId: data.inviter.user.id, eventType: 'org_invite', organizationId: data.organization.id, request });
				},
			}),
		],
		user: {
			deleteUser: {
				enabled: false,
			},
		},
		session: {
			additionalFields: { authenticatedAt: { type: 'date', required: false, input: false } },
			cookieCache: {
				...SESSION_COOKIE_CACHE,
				version: '2',
			},
		},
		databaseHooks: {
			organization: {
				update: {
					before: async (organizationData: { id?: string } & Record<string, unknown>) => {
						// Block updates to banned organizations.
						// better-auth's organization.update() passes the full org with id.
						if (!organizationData.id) return; // Can't check without an ID
						const organizationId = organizationData.id;
						try {
							const authDatabase = drizzle(environment.DB, { schema });
							const orgRows = await authDatabase
								.select({ bannedAt: schema.organization.bannedAt })
								.from(schema.organization)
								.where(eq(schema.organization.id, organizationId))
								.limit(1);

							if (orgRows.length > 0 && orgRows[0].bannedAt) {
								throw new APIError('FORBIDDEN', { message: 'CONTACT_SUPPORT' });
							}
						} catch (error) {
							// Re-throw APIError; swallow unexpected DB errors to avoid
							// breaking the auth flow. This is a deliberate fail-open trade-off:
							// a transient D1 error allows the update rather than blocking
							// all org updates. The ban is still enforced at the route level.
							if (error instanceof APIError) throw error;
							console.error('Failed to check org ban status during organization update:', error);
						}
					},
				},
			},
			member: {
				create: {
					after: async (member: { userId: string; organizationId: string }) => {
						// Track org_join when a user accepts an invitation.
						// The personal-org member created during signup is inserted
						// via raw Drizzle (not the adapter), so this hook only fires
						// for invitation accepts.
						trackAuthEvent({ userId: member.userId, eventType: 'org_join', organizationId: member.organizationId, request });
					},
				},
			},
			user: {
				create: {
					after: async (user) => {
						// Auto-create a personal organization for every new user.
						// Uses D1 batch() for atomicity — both inserts succeed or neither does.
						// Retries up to 3 times to handle rare slug uniqueness collisions.
						const authDatabase = drizzle(environment.DB, { schema });

						let lastError: unknown;
						for (let attempt = 0; attempt < 3; attempt++) {
							try {
								const organizationId = crypto.randomUUID();
								const now = new Date();
								const orgSlug = crypto.randomUUID();

								await authDatabase.batch([
									authDatabase.insert(schema.organization).values({
										id: organizationId,
										name: `${user.name}'s Workspace`,
										slug: orgSlug,
										plan: PLAN_FREE,
										createdAt: now,
									}),
									authDatabase.insert(schema.member).values({
										id: crypto.randomUUID(),
										organizationId,
										userId: user.id,
										role: 'owner',
										createdAt: now,
									}),
								]);

								trackAuthEvent({ userId: user.id, eventType: 'signup', request });
								trackAuthEvent({ userId: user.id, eventType: 'org_create', organizationId, request });
								break;
							} catch (error) {
								const message = error instanceof Error ? error.message : String(error);
								if (!message.includes('UNIQUE constraint failed')) {
									console.error('Failed to create personal organization for user:', user.id, error);
									break;
								}
								lastError = error;
							}
						}
						if (lastError) {
							console.error('Failed to create personal organization for user after retries:', user.id, lastError);
						}
					},
				},
			},
			session: {
				create: {
					before: async (session) => {
						// Soft-deleted users are restored on sign-in.
						try {
							const authDatabase = drizzle(environment.DB, { schema });
							const userRows = await authDatabase
								.select({ deletedAt: schema.user.deletedAt })
								.from(schema.user)
								.where(eq(schema.user.id, session.userId))
								.limit(1);

							if (userRows.length === 0) return;

							if (userRows[0].deletedAt) {
								await authDatabase
									.update(schema.user)
									// eslint-disable-next-line unicorn/no-null -- Drizzle ORM requires null to clear nullable columns
									.set({ deletedAt: null, updatedAt: new Date() })
									.where(eq(schema.user.id, session.userId));
							}

							// Look up the provider used for this session's account
							const accountRows = await authDatabase
								.select({ providerId: schema.account.providerId })
								.from(schema.account)
								.where(eq(schema.account.userId, session.userId))
								.limit(1);
							trackAuthEvent({ userId: session.userId, eventType: 'login', provider: accountRows[0]?.providerId, request });
						} catch (error) {
							console.error('Failed to check user status during session creation:', error);
						}
					},
				},
			},
		},
		advanced: {
			database: {
				generateId: 'uuid',
			},
			ipAddress: {
				ipAddressHeaders: [...IP_ADDRESS_HEADERS],
			},
		},
	});
}

export type Auth = ReturnType<typeof createAuth>;
