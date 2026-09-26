import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import { buildAppOrigin, parseHost } from '@shared/domain';
import { validatePreviewToken } from '@shared/preview-token';
import { isValidProjectId } from '@shared/project-id';

import { applyPreviewRobotsHeader } from './security';
import { resolveSessionFromRequest } from './session';
import * as authSchema from '../db/auth-schema';
import { errorPage } from '../lib/error-page';
import { buildPreviewAccessLoginUrl, buildPreviewRedeemUrl, createPreviewAccessGrant, getRedirectPath } from '../lib/preview-access';
import { DEV_PREVIEW_SECRET } from '../lib/preview-secret';

import type { AuthedEnvironment } from '../types';

export function registerPreviewAccessRoutes(app: Hono<AuthedEnvironment>): void {
	app.use('/p/:projectId/__preview-auth/*', async (c, next) => {
		await next();
		c.res = applyPreviewRobotsHeader(c.res);
	});

	app.get('/p/:projectId/__preview-auth/bootstrap', async (c) => {
		const { projectId } = c.req.param();
		if (!isValidProjectId(projectId)) {
			return c.notFound();
		}

		const currentUrl = new URL(c.req.url);
		const appOrigin = buildAppOrigin(parseHost(currentUrl.host).baseDomain, currentUrl.protocol);
		const returnTo = c.req.query('returnTo');
		if (!returnTo) {
			return errorPage({
				heading: 'Invalid preview link',
				message: 'This preview link is missing its return target.',
				homeUrl: `${appOrigin}/`,
				status: 400,
			});
		}

		let returnToUrl: URL;
		try {
			returnToUrl = new URL(returnTo);
		} catch {
			return errorPage({
				heading: 'Invalid preview link',
				message: 'This preview link could not be validated.',
				homeUrl: `${appOrigin}/`,
				status: 400,
			});
		}

		const parsedReturnHost = parseHost(returnToUrl.host);
		if (
			parsedReturnHost.type !== 'preview' ||
			parsedReturnHost.projectId !== projectId ||
			parsedReturnHost.baseDomain !== parseHost(currentUrl.host).baseDomain
		) {
			return errorPage({
				heading: 'Invalid preview link',
				message: 'This preview link does not belong to this project.',
				homeUrl: `${appOrigin}/`,
				status: 400,
			});
		}

		const secret = import.meta.env.DEV ? c.env.PREVIEW_SECRET || DEV_PREVIEW_SECRET : c.env.PREVIEW_SECRET;
		const isValidToken = await validatePreviewToken(parsedReturnHost.projectId, parsedReturnHost.token, secret);
		if (!isValidToken) {
			return errorPage({
				heading: 'Preview link expired',
				message: 'This preview link is no longer valid. Open the editor to get a fresh preview link.',
				homeUrl: `${appOrigin}/`,
				status: 403,
			});
		}

		const database = drizzle(c.env.DB, { schema: authSchema });
		const previewProjectRow = await database
			.select({
				deletedAt: authSchema.project.deletedAt,
				projectBannedAt: authSchema.project.bannedAt,
				orgDeletedAt: authSchema.organization.deletedAt,
				orgBannedAt: authSchema.organization.bannedAt,
				previewVisibility: authSchema.project.previewVisibility,
				organizationId: authSchema.project.organizationId,
			})
			.from(authSchema.project)
			.leftJoin(authSchema.organization, eq(authSchema.project.organizationId, authSchema.organization.id))
			.where(eq(authSchema.project.id, projectId))
			.limit(1);

		if (previewProjectRow.length === 0 || previewProjectRow[0].deletedAt || previewProjectRow[0].orgDeletedAt) {
			return errorPage({
				heading: 'Project not found',
				message: "The project you're looking for doesn't exist or has expired.",
				homeUrl: `${appOrigin}/`,
				status: 404,
			});
		}

		if (previewProjectRow[0].projectBannedAt || previewProjectRow[0].orgBannedAt) {
			return errorPage({
				heading: 'Access restricted',
				message: 'Please contact us for assistance.',
				homeUrl: `${appOrigin}/`,
				status: 403,
			});
		}

		if ((previewProjectRow[0].previewVisibility ?? 'public') !== 'private') {
			return Response.redirect(returnToUrl.toString(), 302);
		}

		const session = await resolveSessionFromRequest(c.req.raw, c.env, appOrigin);
		if (!session) {
			return Response.redirect(buildPreviewAccessLoginUrl(appOrigin, currentUrl.toString()), 302);
		}

		const memberRow = await database
			.select({ id: authSchema.member.id })
			.from(authSchema.member)
			.where(and(eq(authSchema.member.organizationId, previewProjectRow[0].organizationId), eq(authSchema.member.userId, session.userId)))
			.limit(1);
		if (memberRow.length === 0) {
			return errorPage({
				heading: 'Private project',
				message: 'You do not have access to this preview.',
				homeUrl: `${appOrigin}/`,
				status: 403,
			});
		}

		const grant = await createPreviewAccessGrant(
			{
				projectId,
				previewToken: parsedReturnHost.token,
				organizationId: previewProjectRow[0].organizationId,
				userId: session.userId,
				redirectPath: getRedirectPath(returnToUrl),
			},
			secret,
		);

		return Response.redirect(buildPreviewRedeemUrl(returnToUrl.origin, grant), 302);
	});
}
