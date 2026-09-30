import { APIError, createAuthMiddleware, getAuthoritativeSessionFromCtx, getOAuthState } from 'better-auth/api';
import { and, eq, gt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { z } from 'zod';

import { account, verification } from '../db/auth-schema';

import type { BetterAuthPlugin } from 'better-auth';

const challengeValue = z.object({
	sessionId: z.string(),
	userId: z.string(),
	providerId: z.string(),
	accountId: z.string(),
	token: z.string(),
});
const providerIdentity = z.object({ sub: z.string().optional(), id: z.union([z.string(), z.number()]).optional() });
const challengeLifetime = 10 * 60 * 1000;

export function sessionReauthentication(databaseBinding: D1Database, configuredProviders: string[]): BetterAuthPlugin {
	const database = drizzle(databaseBinding);
	const successPath = '/settings/account?reauth=success';
	const errorPath = '/settings/account?reauth=error';
	return {
		id: 'session-reauthentication',
		hooks: {
			before: [
				{
					matcher: (context) => context.path === '/link-social' && context.body?.additionalData?.intent === 'reauthenticate',
					handler: createAuthMiddleware(async (context) => {
						const current = await getAuthoritativeSessionFromCtx(context);
						if (!current) throw new APIError('UNAUTHORIZED', { message: 'Sign in is required.' });
						const providerId = context.body.provider;
						if (!configuredProviders.includes(providerId) || context.body.idToken || current.session.impersonatedBy) {
							throw new APIError('BAD_REQUEST', { message: 'Choose a linked sign-in provider.' });
						}
						const [linked] = await database
							.select({ accountId: account.accountId })
							.from(account)
							.where(and(eq(account.userId, current.user.id), eq(account.providerId, providerId)))
							.limit(1);
						if (!linked) throw new APIError('BAD_REQUEST', { message: 'Choose a linked sign-in provider.' });
						const challengeId = crypto.randomUUID();
						const now = new Date();
						await database.insert(verification).values({
							id: challengeId,
							identifier: `reauthentication:${challengeId}`,
							value: JSON.stringify({
								sessionId: current.session.id,
								userId: current.user.id,
								providerId,
								accountId: linked.accountId,
								token: current.session.token,
							}),
							expiresAt: new Date(now.getTime() + challengeLifetime),
							createdAt: now,
							updatedAt: now,
						});
						return {
							context: {
								body: {
									...context.body,
									callbackURL: successPath,
									errorCallbackURL: errorPath,
									additionalData: { intent: 'reauthenticate', reauthenticationChallenge: challengeId },
								},
							},
						};
					}),
				},
				{
					matcher: (context) => context.path?.startsWith('/callback/') ?? false,
					handler: createAuthMiddleware(async (context) => ({
						context: {
							context: {
								socialProviders: context.context.socialProviders.map((provider) => ({
									...provider,
									getUserInfo: async (tokens: Parameters<typeof provider.getUserInfo>[0]) => {
										const information = await provider.getUserInfo(tokens);
										const state = await getOAuthState();
										if (state?.intent !== 'reauthenticate' && !state?.reauthenticationChallenge) return information;
										const challengeId = state.reauthenticationChallenge;
										if (typeof challengeId !== 'string' || !state.link) throw context.redirect(errorPath);
										const [stored] = await database
											.select()
											.from(verification)
											.where(and(eq(verification.identifier, `reauthentication:${challengeId}`), gt(verification.expiresAt, new Date())))
											.limit(1);
										if (!stored) throw context.redirect(errorPath);
										const parsed = challengeValue.safeParse(JSON.parse(stored.value));
										const identity = providerIdentity.safeParse(information?.data);
										const current = await getAuthoritativeSessionFromCtx(context);
										if (!parsed.success || !identity.success || !current) throw context.redirect(errorPath);
										const challenge = parsed.data;
										const accountId = provider.id === 'google' ? identity.data.sub : identity.data.id;
										if (
											!information?.user ||
											challenge.providerId !== provider.id ||
											accountId === undefined ||
											challenge.accountId !== String(accountId) ||
											challenge.sessionId !== current.session.id ||
											challenge.token !== current.session.token ||
											challenge.userId !== current.user.id ||
											state.link.userId !== challenge.userId
										)
											throw context.redirect(errorPath);
										const now = Math.floor(Date.now() / 1000);
										const [updated] = await databaseBinding.batch([
											databaseBinding
												.prepare(
													`UPDATE session SET authenticated_at = ? WHERE id = ? AND user_id = ? AND token = ? AND expires_at > ?
												AND EXISTS (SELECT 1 FROM verification WHERE id = ? AND identifier = ? AND value = ? AND expires_at > ?)
												AND EXISTS (SELECT 1 FROM account WHERE user_id = ? AND provider_id = ? AND account_id = ?)`,
												)
												.bind(
													now,
													challenge.sessionId,
													challenge.userId,
													challenge.token,
													now,
													stored.id,
													stored.identifier,
													stored.value,
													now,
													challenge.userId,
													challenge.providerId,
													challenge.accountId,
												),
											databaseBinding
												.prepare('DELETE FROM verification WHERE id = ? AND identifier = ?')
												.bind(stored.id, stored.identifier),
										]);
										throw context.redirect(updated.meta.changes === 1 ? successPath : errorPath);
									},
								})),
							},
						},
					})),
				},
			],
		},
	};
}
