import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import { buildPreviewOrigin } from '@shared/domain';
import { HttpErrorCode } from '@shared/http-errors';
import { generatePreviewToken } from '@shared/preview-token';

import * as schema from '../db/auth-schema';
import { getDomainConfiguration } from '../lib/domain-configuration';
import { httpError } from '../lib/http-error';
import { buildPreviewRedeemUrl, createPreviewAccessGrant } from '../lib/preview-access';
import { DEV_PREVIEW_SECRET } from '../lib/preview-secret';

import type { AppEnvironment } from '../types';
export const previewUrlRoutes = new Hono<AppEnvironment>()
	/**
	 * GET /api/preview-url
	 *
	 * Returns a signed preview URL for the current project. The URL
	 * contains an HMAC token valid for 1–2 hours (current + previous
	 * time bucket).
	 *
	 * The frontend should call this once on IDE load and again whenever
	 * the preview iframe returns a 403 (token expired).
	 */
	.get('/preview-url', async (c) => {
		const projectId = c.get('projectId');
		const { userId } = c.get('session');

		// Rate-limit token generation per authenticated user to prevent token farming.
		if (env.PREVIEW_RATE_LIMITER) {
			const { success } = await env.PREVIEW_RATE_LIMITER.limit({ key: userId });
			if (!success) {
				throw httpError(HttpErrorCode.RATE_LIMITED, 'Too many preview URL requests. Please wait before retrying.');
			}
		}

		const secret = import.meta.env.DEV ? env.PREVIEW_SECRET || DEV_PREVIEW_SECRET : env.PREVIEW_SECRET;

		const token = await generatePreviewToken(projectId, secret);

		const previewOrigin = buildPreviewOrigin(projectId, token, getDomainConfiguration(c.env).contentOrigin);
		const directPreviewUrl = `${previewOrigin}/`;

		const database = drizzle(c.env.DB, { schema });
		const projectRows = await database
			.select({ previewVisibility: schema.project.previewVisibility, organizationId: schema.project.organizationId })
			.from(schema.project)
			.where(eq(schema.project.id, projectId))
			.limit(1);
		const previewProject = projectRows[0];
		const previewVisibility = previewProject?.previewVisibility ?? 'public';

		const previewUrl =
			previewVisibility === 'private' && previewProject?.organizationId
				? buildPreviewRedeemUrl(
						previewOrigin,
						await createPreviewAccessGrant(
							{
								projectId,
								previewToken: token,
								previewOrigin,
								organizationId: previewProject.organizationId,
								userId,
								redirectPath: '/',
							},
							secret,
						),
					)
				: directPreviewUrl;

		return c.json({ url: previewUrl, origin: previewOrigin });
	});

export type PreviewUrlRoutes = typeof previewUrlRoutes;
