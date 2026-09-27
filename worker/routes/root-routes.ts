import { env } from 'cloudflare:workers';
import { Hono } from 'hono';

import { HttpErrorCode } from '@shared/http-errors';
import { isValidProjectId } from '@shared/project-id';

import { httpError } from '../lib/http-error';
import { cloneProject } from '../services/projects/clone-project';
import { createProject } from '../services/projects/create-project';
import { getTemplateMetadata } from '../templates';

import type { AuthedEnvironment } from '../types';
import type { MiddlewareHandler } from 'hono';

// Keep the established root-endpoint JSON parse errors while exposing request
// bodies to Hono RPC. Field validation remains in the handlers below.
function rootJsonBody<Body extends object>(
	message: string,
): MiddlewareHandler<AuthedEnvironment, string, { in: { json: Body }; out: { json: Body } }> {
	return async (context, next) => {
		try {
			context.req.addValidatedData('json', await context.req.json<Body>());
		} catch {
			throw httpError(HttpErrorCode.VALIDATION_ERROR, message, undefined, { includeCode: false });
		}
		await next();
	};
}

export const publicRootRoutes = new Hono<AuthedEnvironment>()
	.get('/health', (c) => c.json({ ok: true }))
	.get('/templates', (c) => c.json({ templates: getTemplateMetadata() }))
	.get('/version', (c) => {
		const metadata = env.CF_VERSION_METADATA;
		return c.json({ id: metadata.id, timestamp: metadata.timestamp, tag: metadata.tag });
	});

export const protectedRootRoutes = new Hono<AuthedEnvironment>()
	.post(
		'/new-project',
		rootJsonBody<{ template: string; organizationId: string }>('Request body must contain a template ID and organizationId'),
		async (c) => {
			const { userId } = c.get('session');
			let templateId: string;
			let organizationId: string;
			try {
				const body: { template: string; organizationId: string } = await c.req.json();
				templateId = body.template;
				organizationId = body.organizationId;
			} catch {
				throw httpError(HttpErrorCode.VALIDATION_ERROR, 'Request body must contain a template ID and organizationId', undefined, {
					includeCode: false,
				});
			}
			if (!templateId) {
				throw httpError(HttpErrorCode.VALIDATION_ERROR, 'Request body must contain a template ID', undefined, { includeCode: false });
			}
			if (!organizationId) {
				throw httpError(HttpErrorCode.VALIDATION_ERROR, 'Request body must contain an organizationId', undefined, { includeCode: false });
			}

			return c.json(await createProject({ databaseBinding: c.env.DB, organizationId, request: c.req.raw, templateId, userId }));
		},
	)
	.post(
		'/clone-project',
		rootJsonBody<{ sourceProjectId: string; organizationId: string }>('Request body must contain sourceProjectId and organizationId'),
		async (c) => {
			const { userId } = c.get('session');
			let sourceProjectId: string;
			let organizationId: string;
			try {
				const body: { sourceProjectId: string; organizationId: string } = await c.req.json();
				sourceProjectId = body.sourceProjectId;
				organizationId = body.organizationId;
			} catch {
				throw httpError(HttpErrorCode.VALIDATION_ERROR, 'Request body must contain sourceProjectId and organizationId', undefined, {
					includeCode: false,
				});
			}
			if (!organizationId) {
				throw httpError(HttpErrorCode.VALIDATION_ERROR, 'Request body must contain an organizationId', undefined, { includeCode: false });
			}
			if (!sourceProjectId || !isValidProjectId(sourceProjectId)) {
				throw httpError(HttpErrorCode.VALIDATION_ERROR, 'Invalid source project ID.', undefined, { includeCode: false });
			}

			return c.json(await cloneProject({ databaseBinding: c.env.DB, organizationId, request: c.req.raw, sourceProjectId, userId }));
		},
	);

const _rootRoutes = new Hono<AuthedEnvironment>().route('', publicRootRoutes).route('', protectedRootRoutes);
export type RootApiRoutes = typeof _rootRoutes;
