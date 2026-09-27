import { and, eq, isNotNull, isNull, lte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import { PROJECT_INACTIVITY_DAYS, SOFT_DELETE_RETENTION_DAYS } from '@shared/constants';
import { parseHost } from '@shared/domain';
import { validatePreviewToken } from '@shared/preview-token';

import { app } from './app';
import { isHotlinkRequest, handlePreviewRequest } from './preview';
import { composeResponseMiddleware, previewRobotsHeadersMiddleware, appSecurityHeadersMiddleware } from './security';
import * as authSchema from '../db/auth-schema';
import { coordinatorNamespace } from '../lib/durable-object-namespaces';
import { errorPage, previewExpiredPage } from '../lib/error-page';
import { DEV_PREVIEW_SECRET } from '../lib/preview-secret';
import { handleGitProxy } from '../services/git-proxy';
import { PROJECT_DELETED_VIA_PROJECT, hardDeleteProjectById, hardDeleteOrganizationById } from '../services/projects/retention';

/**
 * Extract the project ID (Artifacts repo name) from a `cf.artifacts.repo.pushed`
 * event subscription message, or undefined if the message is not a push event.
 */
function extractPushedProjectId(event: unknown): string | undefined {
	if (typeof event !== 'object' || event === null) return undefined;
	if (!('type' in event) || event.type !== 'cf.artifacts.repo.pushed') return undefined;
	if (!('source' in event) || typeof event.source !== 'object' || event.source === null) return undefined;
	if (!('repoName' in event.source) || typeof event.source.repoName !== 'string') return undefined;
	return event.source.repoName;
}

export default {
	async fetch(request: Request, environment: Env, executionContext: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Guard: reject WebSocket upgrade requests that don't match a known
		// WebSocket handler path before any routing can forward them to
		// env.ASSETS.fetch(). In the miniflare dev environment, forwarding a
		// WebSocket upgrade to the ASSETS node-service binding causes an
		// unrecoverable ERR_ASSERTION crash inside #handleLoopback because the
		// upgrade path calls #handleLoopback(req) without a `res` argument, but
		// the node-service branch unconditionally asserts that `res` is truthy.
		//
		// Valid WebSocket paths:
		//   - App domain:     /p/<projectId>/__ws   (ProjectCoordinator)
		//   - App domain:     /p/<projectId>/__agent (AgentRunner)
		//   - Preview domain: /__ws                  (ProjectCoordinator)
		if (request.headers.get('Upgrade') === 'websocket') {
			const isValidWebSocketPath =
				url.pathname === '/__ws' ||
				url.pathname.startsWith('/__ws/') ||
				/^\/p\/[^/]+\/__ws(\/|$)/.test(url.pathname) ||
				/^\/p\/[^/]+\/__agent(\/|$)/.test(url.pathname) ||
				/^\/p\/[^/]+\/api\/stt\/ws$/.test(url.pathname);

			if (!isValidWebSocketPath) {
				return new Response('WebSocket not supported on this path', { status: 404 });
			}
		}

		const parsed = parseHost(url.host);

		switch (parsed.type) {
			case 'preview': {
				return composeResponseMiddleware(request, async () => {
					const secret = import.meta.env.DEV ? environment.PREVIEW_SECRET || DEV_PREVIEW_SECRET : environment.PREVIEW_SECRET;
					const isValidToken = await validatePreviewToken(parsed.projectId, parsed.token, secret);
					if (!isValidToken) {
						return previewExpiredPage({ baseDomain: parsed.baseDomain, protocol: url.protocol });
					}

					// Block cross-site subresource requests (hotlinking).
					// Must run after token validation so we don't leak timing info
					// about whether a token is valid to cross-site probes.
					if (isHotlinkRequest(request)) {
						return new Response('Forbidden', { status: 403 });
					}

					// Rate-limit preview requests per project to prevent abuse.
					if (environment.PREVIEW_RATE_LIMITER) {
						const { success } = await environment.PREVIEW_RATE_LIMITER.limit({ key: parsed.projectId });
						if (!success) {
							return new Response('Too Many Requests', { status: 429 });
						}
					}

					return handlePreviewRequest(request, parsed.projectId, parsed.token);
				}, [previewRobotsHeadersMiddleware]);
			}

			case 'git': {
				// Proxy Git Smart HTTP requests to the project's Cloudflare Artifacts
				// remote. We verify our own short-lived token and mint a scoped
				// Artifacts token before forwarding (the Artifacts token never
				// reaches the client).
				return handleGitProxy(request, environment);
			}

			case 'app': {
				return composeResponseMiddleware(request, async () => app.fetch(request, environment, executionContext), [
					appSecurityHeadersMiddleware,
				]);
			}

			case 'unknown': {
				const homeUrl = `${url.protocol}//${parsed.baseDomain}/`;
				return errorPage({
					heading: 'Page not found',
					message: "The page you're looking for doesn't exist.",
					homeUrl,
					status: 404,
				});
			}
		}
	},

	/**
	 * Queue consumer for Cloudflare Artifacts event subscriptions.
	 * When commits are pushed to a project's Artifacts repo (by an external
	 * client or another session), Artifacts emits a `cf.artifacts.repo.pushed`
	 * event. This handler broadcasts git-status-changed to all connected
	 * WebSocket clients for the affected project. The repo name is the projectId.
	 */
	async queue(batch: MessageBatch, _environment: Env, _executionContext: ExecutionContext): Promise<void> {
		for (const message of batch.messages) {
			try {
				const event: unknown = message.body;
				const projectId = extractPushedProjectId(event);
				if (projectId) {
					const coordinatorStub = coordinatorNamespace.getByName(`project:${projectId}`);
					await coordinatorStub.sendMessage({ type: 'git-status-changed' });
				}
				message.ack();
			} catch (error) {
				console.error('Queue message processing failed:', error);
				message.retry();
			}
		}
	},

	/**
	 * Scheduled handler — runs daily via cron trigger (03:00 UTC).
	 *
	 * Lifecycle cleanup:
	 * 1. Auto soft-delete projects older than PROJECT_INACTIVITY_DAYS (1 year).
	 * 2. Permanently purge projects, organizations, and users soft-deleted more than
	 *    SOFT_DELETE_RETENTION_DAYS (30 days) ago.
	 */
	async scheduled(_event: ScheduledEvent, environment: Env, _executionContext: ExecutionContext): Promise<void> {
		const database = drizzle(environment.DB, { schema: authSchema });
		const now = new Date();

		// Phase 1: Auto soft-delete projects older than 1 year
		const inactivityCutoff = new Date(now.getTime() - PROJECT_INACTIVITY_DAYS * 24 * 60 * 60 * 1000);
		const staleProjects = await database
			.select({ id: authSchema.project.id })
			.from(authSchema.project)
			.where(and(isNull(authSchema.project.deletedAt), lte(authSchema.project.lastActivityAt, inactivityCutoff)));

		if (staleProjects.length > 0) {
			console.log(`Auto soft-deleting ${staleProjects.length} project(s) older than ${PROJECT_INACTIVITY_DAYS} days`);
			for (const project of staleProjects) {
				await database.batch([
					database
						.update(authSchema.project)
						.set({ deletedAt: now, deletedViaType: PROJECT_DELETED_VIA_PROJECT, deletedViaId: project.id, updatedAt: now })
						.where(eq(authSchema.project.id, project.id)),
					database
						.update(authSchema.projectTransfer)
						.set({ status: 'cancelled', resolvedAt: now })
						.where(and(eq(authSchema.projectTransfer.projectId, project.id), eq(authSchema.projectTransfer.status, 'pending'))),
				]);
			}
		}

		// Phase 2: Permanently purge projects soft-deleted more than 30 days ago
		const purgeCutoff = new Date(now.getTime() - SOFT_DELETE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
		const expiredProjects = await database
			.select({ id: authSchema.project.id, durableObjectHexId: authSchema.project.durableObjectHexId })
			.from(authSchema.project)
			.where(and(isNotNull(authSchema.project.deletedAt), lte(authSchema.project.deletedAt, purgeCutoff)));

		if (expiredProjects.length > 0) {
			console.log(`Purging ${expiredProjects.length} soft-deleted project(s)`);

			for (const project of expiredProjects) {
				const deleted = await hardDeleteProjectById(database, project);
				if (!deleted) {
					continue;
				}

				console.log(`Purged project ${project.id}`);
			}
		}

		const expiredOrganizations = await database
			.select({ id: authSchema.organization.id })
			.from(authSchema.organization)
			.where(and(isNotNull(authSchema.organization.deletedAt), lte(authSchema.organization.deletedAt, purgeCutoff)));

		if (expiredOrganizations.length > 0) {
			console.log(`Purging ${expiredOrganizations.length} soft-deleted organization(s)`);

			for (const organization of expiredOrganizations) {
				const deleted = await hardDeleteOrganizationById(database, organization.id);
				if (!deleted) {
					console.warn(`Skipped purging organization ${organization.id} because one or more projects could not be fully deleted.`);
					continue;
				}

				console.log(`Purged organization ${organization.id}`);
			}
		}

		const expiredUsers = await database
			.select({ id: authSchema.user.id })
			.from(authSchema.user)
			.where(and(isNotNull(authSchema.user.deletedAt), lte(authSchema.user.deletedAt, purgeCutoff)));

		if (expiredUsers.length > 0) {
			console.log(`Purging ${expiredUsers.length} soft-deleted user(s)`);

			for (const user of expiredUsers) {
				const softDeletedOrgMemberships = await database
					.select({ organizationId: authSchema.member.organizationId })
					.from(authSchema.member)
					.innerJoin(authSchema.organization, eq(authSchema.organization.id, authSchema.member.organizationId))
					.where(and(eq(authSchema.member.userId, user.id), isNotNull(authSchema.organization.deletedAt)));

				if (softDeletedOrgMemberships.length > 0) {
					console.warn(`Skipped purging user ${user.id} because they still belong to soft-deleted organizations awaiting final cleanup.`);
					continue;
				}

				await database.delete(authSchema.user).where(eq(authSchema.user.id, user.id));
				console.log(`Purged user ${user.id}`);
			}
		}
	},
};
