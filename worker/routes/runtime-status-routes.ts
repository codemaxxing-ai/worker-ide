import { Hono } from 'hono';

import { readContainerCapacityError } from '@shared/container-capacity';
import { buildPreviewOrigin } from '@shared/domain';
import { HttpErrorCode } from '@shared/http-errors';
import { generatePreviewToken } from '@shared/preview-token';

import { getDomainConfiguration } from '../lib/domain-configuration';
import { filesystemNamespace } from '../lib/durable-object-namespaces';
import { httpError } from '../lib/http-error';
import { PREVIEW_BOOTSTRAP_INPUTS } from '../lib/preview-bootstrap';
import { DEV_PREVIEW_SECRET } from '../lib/preview-secret';
import { toDurableObjectId } from '../lib/project-id';
import { PreviewService } from '../services/preview-service';

import type { AppEnvironment } from '../types';

export const runtimeStatusRoutes = new Hono<AppEnvironment>()
	.get('/runtime-status', async (context) => {
		const project = filesystemNamespace.get(toDurableObjectId(filesystemNamespace, context.get('projectId')));
		return context.json(await project.getRuntimeStatus());
	})
	.post('/runtime/switch-to-container', async (context) => {
		const projectId = context.get('projectId');
		const project = context.get('fsStub');
		const status = await project.getRuntimeStatus();
		if (status.preview.backend === 'container' && status.preview.phase === 'ready') return context.json(status);
		await project.promoteBuildRuntime('preview', 'explicit-choice');
		try {
			const domains = getDomainConfiguration(context.env);
			const secret = import.meta.env.DEV ? context.env.PREVIEW_SECRET || DEV_PREVIEW_SECRET : context.env.PREVIEW_SECRET;
			const origin = buildPreviewOrigin(projectId, await generatePreviewToken(projectId, secret), domains.contentOrigin);
			const bootstrap = await project.collectPreviewBootstrap(PREVIEW_BOOTSTRAP_INPUTS);
			const response = await new PreviewService(context.get('projectRoot'), projectId).routePreviewRequest(
				new Request(`${origin}/`),
				domains.appOrigin,
				bootstrap,
			);
			await response.body?.cancel();
			if (!response.ok) throw httpError(HttpErrorCode.BUILD_FAILED, 'Container preview could not start');
			return context.json(await project.getRuntimeStatus());
		} catch (error) {
			if (readContainerCapacityError(error))
				throw httpError(
					HttpErrorCode.CONTAINER_LIMIT_REACHED,
					error instanceof Error ? error.message : 'Organization container limit reached',
				);
			throw error;
		}
	});
