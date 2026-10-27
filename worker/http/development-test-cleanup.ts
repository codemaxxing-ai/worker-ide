import { zValidator } from '@hono/zod-validator';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { z } from 'zod';

import { HttpErrorCode } from '@shared/http-errors';

import { project } from '../db/auth-schema';
import { coordinatorNamespace, filesystemNamespace } from '../lib/durable-object-namespaces';
import { httpError } from '../lib/http-error';

import type { AuthedEnvironment } from '../types';

/** Mounted only in development. A test can release only its explicitly listed test-organization projects. */
export const developmentTestCleanupRoutes = new Hono<AuthedEnvironment>().post(
	'/__test/cleanup',
	zValidator('json', z.object({ projectIds: z.array(z.string()).max(500) })),
	async (context) => {
		const { projectIds } = context.req.valid('json');
		if (projectIds.length === 0) return context.json({ ok: true });
		const database = drizzle(context.env.DB);
		const projects = await database
			.select({ id: project.id, durableObjectHexId: project.durableObjectHexId })
			.from(project)
			.where(and(eq(project.organizationId, '11111111-1111-4111-8111-111111111111'), inArray(project.id, projectIds)));
		const failed: string[] = [];
		for (const entry of projects) {
			try {
				await coordinatorNamespace.getByName(`project:${entry.id}`).closeProjectConnections(4004, 'project-deleted');
				const filesystem = filesystemNamespace.get(filesystemNamespace.idFromString(entry.durableObjectHexId));
				// A timed-out test may still have a native install holding the mutation queue.
				await filesystem.cancelComputerSessionExecutions('native-preview');
				await filesystem.cancelComputerSessionExecutions('native-build');
				await filesystem.destroyStorage();
				// Keep the row discoverable if teardown fails, so cleanup can be retried safely.
				await database.delete(project).where(eq(project.id, entry.id));
			} catch (error) {
				console.error(`Test project cleanup failed for ${entry.id}:`, error);
				failed.push(entry.id);
			}
		}
		if (failed.length > 0) throw httpError(HttpErrorCode.INTERNAL_ERROR, `Failed to release test projects: ${failed.join(', ')}`);
		return context.json({ ok: true });
	},
);

export type DevelopmentTestCleanupRoutes = typeof developmentTestCleanupRoutes;
