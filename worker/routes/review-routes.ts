import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

import { reviewHunkUpdateSchema, reviewResolveManySchema, reviewResolveSchema } from '@shared/validation';

import { projectAgentNamespace } from '../lib/durable-object-namespaces';

import type { AppEnvironment } from '../types';

const reviewIdParameterSchema = z.object({ id: z.string().min(1) });

export const reviewRoutes = new Hono<AppEnvironment>()
	.get('/review', async (c) =>
		c.json({ entries: await projectAgentNamespace.getByName(`agent:${c.get('projectId')}`).listReviewEntries() }),
	)
	.put('/review/:id/hunks', zValidator('param', reviewIdParameterSchema), zValidator('json', reviewHunkUpdateSchema), async (c) => {
		const { hunkStatuses, liveContent } = c.req.valid('json');
		await projectAgentNamespace
			.getByName(`agent:${c.get('projectId')}`)
			.updateReviewHunks(c.req.valid('param').id, hunkStatuses, liveContent);
		return c.json({ success: true });
	})
	.post('/review/:id/resolve', zValidator('param', reviewIdParameterSchema), zValidator('json', reviewResolveSchema), async (c) => {
		const { decision, liveContent } = c.req.valid('json');
		await projectAgentNamespace.getByName(`agent:${c.get('projectId')}`).resolveReviewEntry(c.req.valid('param').id, decision, liveContent);
		return c.json({ success: true });
	})
	.post('/review/resolve-many', zValidator('json', reviewResolveManySchema), async (c) => {
		const { decision, sessionId, reviewIds, liveContents } = c.req.valid('json');
		await projectAgentNamespace.getByName(`agent:${c.get('projectId')}`).resolveReviewEntries(decision, sessionId, reviewIds, liveContents);
		return c.json({ success: true });
	});

export type ReviewRoutes = typeof reviewRoutes;
