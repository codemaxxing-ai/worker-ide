import { Hono } from 'hono';

import { filesystemNamespace } from '../lib/durable-object-namespaces';
import { toDurableObjectId } from '../lib/project-id';

import type { AppEnvironment } from '../types';

export const runtimeStatusRoutes = new Hono<AppEnvironment>().get('/runtime-status', async (context) => {
	const project = filesystemNamespace.get(toDurableObjectId(filesystemNamespace, context.get('projectId')));
	return context.json(await project.getRuntimeStatus());
});
