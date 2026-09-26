import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import { buildAppOrigin, parseHost } from '@shared/domain';

import { parseProjectRoute, PROJECT_ROOT } from './project-context';
import { UNSAFE_METHODS, hasValidAppRequestOrigin, hasValidWebSocketOrigin } from './security';
import * as authSchema from '../db/auth-schema';
import { agentRunnerNamespace, coordinatorNamespace, filesystemNamespace } from '../lib/durable-object-namespaces';
import { runWithProjectStub } from '../lib/project-fs';
import { toDurableObjectId } from '../lib/project-id';
import { apiRoutes } from '../routes';
import { developmentTestRoutes } from '../routes/development-test-routes';

import type { AppEnvironment } from '../types';

export const projectApp = new Hono<AppEnvironment>();

projectApp.use('*', async (c, next) => {
	const path = new URL(c.req.url).pathname;
	const projectRoute = parseProjectRoute(path);

	if (!projectRoute) {
		return env.ASSETS.fetch(c.req.raw);
	}

	const { projectId, subPath } = projectRoute;
	const requestUrl = new URL(c.req.url);
	const appOrigin = buildAppOrigin(parseHost(requestUrl.host).baseDomain, requestUrl.protocol);

	let fsId: DurableObjectId;
	try {
		fsId = toDurableObjectId(filesystemNamespace, projectId);
	} catch {
		if (subPath.startsWith('/api/') || subPath === '/__ws' || subPath.startsWith('/__ws')) {
			return c.notFound();
		}
		return env.ASSETS.fetch(new Request(new URL('/', c.req.url), c.req.raw));
	}

	const isBackendRoute =
		subPath.startsWith('/api/') ||
		subPath === '/__ws' ||
		subPath.startsWith('/__ws') ||
		subPath === '/__agent' ||
		subPath.startsWith('/__agent');
	if (!isBackendRoute) {
		return env.ASSETS.fetch(new Request(new URL('/', c.req.url), c.req.raw));
	}

	const fsStub = filesystemNamespace.get(fsId);
	if (!(await fsStub.projectExists())) {
		return c.notFound();
	}

	// Single query: soft-delete check, ban check (project + org), and membership
	const { userId } = c.get('session');
	if (!userId) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	{
		const database = drizzle(c.env.DB, { schema: authSchema });
		const projectAccessRow = await database
			.select({
				deletedAt: authSchema.project.deletedAt,
				projectBannedAt: authSchema.project.bannedAt,
				orgBannedAt: authSchema.organization.bannedAt,
				memberId: authSchema.member.id,
			})
			.from(authSchema.project)
			.leftJoin(authSchema.organization, eq(authSchema.project.organizationId, authSchema.organization.id))
			.leftJoin(
				authSchema.member,
				and(eq(authSchema.member.organizationId, authSchema.project.organizationId), eq(authSchema.member.userId, userId)),
			)
			.where(eq(authSchema.project.id, projectId))
			.limit(1);

		if (projectAccessRow.length === 0 || projectAccessRow[0].deletedAt) {
			return c.notFound();
		}

		if (projectAccessRow[0].projectBannedAt || projectAccessRow[0].orgBannedAt) {
			return c.json({ error: 'Forbidden' }, 403);
		}

		if (!projectAccessRow[0].memberId) {
			return c.json({ error: 'Forbidden' }, 403);
		}
	}

	// Fire-and-forget: bump project last-activity + per-user access tracking.
	const session = c.get('session');
	if (session.updateActivity) {
		c.executionCtx.waitUntil(
			(async () => {
				try {
					const database = drizzle(c.env.DB, { schema: authSchema });
					const now = new Date();
					await database.batch([
						database
							.insert(authSchema.userProjectAccess)
							.values({
								id: crypto.randomUUID(),
								userId,
								projectId,
								lastAccessedAt: now,
							})
							.onConflictDoUpdate({
								target: [authSchema.userProjectAccess.userId, authSchema.userProjectAccess.projectId],
								set: { lastAccessedAt: now },
							}),
						database.update(authSchema.project).set({ lastActivityAt: now }).where(eq(authSchema.project.id, projectId)),
					]);
				} catch (error) {
					console.error('Failed to record project access:', error);
				}
			})(),
		);
	}

	// Agent SDK WebSocket — forward to the AgentRunner DO.
	// The Agent class (from agents SDK) handles the WebSocket upgrade,
	// state sync, and @callable RPC natively.
	//
	// We must include the `x-partykit-room` header so partyserver can
	// identify the Agent's name on first connection (before it has been
	// persisted to storage). Without it, partyserver throws
	// "Missing namespace or room headers", which in the miniflare dev
	// environment causes an ERR_ASSERTION crash in #handleLoopback.
	if (subPath === '/__agent' || subPath.startsWith('/__agent')) {
		if ((c.req.raw.headers.has('Origin') || UNSAFE_METHODS.has(c.req.method)) && !hasValidAppRequestOrigin(c.req.raw, appOrigin)) {
			return new Response('Forbidden', { status: 403 });
		}
		if (c.req.raw.headers.get('Upgrade') === 'websocket' && !hasValidWebSocketOrigin(c.req.raw, appOrigin)) {
			return new Response('Forbidden', { status: 403 });
		}
		const agentStub = agentRunnerNamespace.getByName(`agent:${projectId}`);
		const agentUrl = new URL(c.req.url);
		agentUrl.pathname = '/';
		const agentHeaders = new Headers(c.req.raw.headers);
		agentHeaders.set('x-partykit-room', `agent:${projectId}`);
		agentHeaders.set('x-worker-ide-user-id', userId);
		agentHeaders.set('x-worker-ide-base-domain', parseHost(requestUrl.host).baseDomain);
		agentHeaders.set('x-worker-ide-protocol', agentUrl.protocol);
		return agentStub.fetch(new Request(agentUrl, { ...c.req.raw, headers: agentHeaders }));
	}

	if (subPath === '/__ws' || subPath.startsWith('/__ws')) {
		if (!hasValidWebSocketOrigin(c.req.raw, appOrigin)) {
			return new Response('Forbidden', { status: 403 });
		}
		const { collaborationVisible } = c.get('session');
		const coordinatorStub = coordinatorNamespace.getByName(`project:${projectId}`);
		const wsUrl = new URL(c.req.url);
		wsUrl.pathname = '/ws';
		const wsRequest = new Request(wsUrl, c.req.raw);
		wsRequest.headers.set('x-project-id', projectId);
		wsRequest.headers.set('x-worker-ide-client-kind', 'ide');
		wsRequest.headers.set('x-worker-ide-collaboration-visible', collaborationVisible ? 'true' : 'false');
		return coordinatorStub.fetch(wsRequest);
	}

	c.set('projectId', projectId);
	c.set('projectRoot', PROJECT_ROOT);
	c.set('fsStub', fsStub);
	await runWithProjectStub(fsStub, next);
});

if (import.meta.env.DEV) {
	projectApp.route('/api', developmentTestRoutes);
}

projectApp.route('/api', apiRoutes);
projectApp.all('/api/*', (c) => c.notFound());
