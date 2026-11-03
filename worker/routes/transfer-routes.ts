import { zValidator } from '@hono/zod-validator';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import { readContainerCapacityError } from '@shared/container-capacity';
import { HttpErrorCode } from '@shared/http-errors';
import { EFFECTIVE_LIMIT_ORG_MAX_PROJECTS } from '@shared/limits';
import { transferInitiateBodySchema } from '@shared/validation';

import * as schema from '../db/auth-schema';
import { trackAuthEvent } from '../lib/analytics';
import { filesystemNamespace } from '../lib/durable-object-namespaces';
import { httpError } from '../lib/http-error';
import { getEffectiveLimit } from '../lib/limits';
import { assertOrgAdmin } from '../lib/project-auth';
import { toDurableObjectId } from '../lib/project-id';

import type { AuthedEnvironment } from '../types';

export const transferRoutes = new Hono<AuthedEnvironment>()
	// POST /api/org/:orgId/project/:projectId/transfer — Initiate a project transfer
	.post('/org/:orgId/project/:projectId/transfer', zValidator('json', transferInitiateBodySchema), async (c) => {
		const { orgId, projectId } = c.req.param();
		const { userId } = c.get('session');
		const database = drizzle(c.env.DB, { schema });

		// Verify user is admin/owner of source org
		await assertOrgAdmin(database, orgId, userId);

		const body = c.req.valid('json');
		if (body.targetOrganizationId === orgId) {
			throw httpError(HttpErrorCode.VALIDATION_ERROR, 'Cannot transfer a project to the same organization.');
		}

		// Verify source org is not banned
		const sourceOrgRow = await database
			.select({ bannedAt: schema.organization.bannedAt, deletedAt: schema.organization.deletedAt })
			.from(schema.organization)
			.where(eq(schema.organization.id, orgId))
			.limit(1);

		if (sourceOrgRow.length === 0 || sourceOrgRow[0].deletedAt) {
			throw httpError(HttpErrorCode.NOT_FOUND, 'Source organization not found.');
		}

		if (sourceOrgRow[0].bannedAt) {
			throw httpError(HttpErrorCode.FORBIDDEN, 'Please contact us for assistance.');
		}

		// Verify project exists in source org, is not soft-deleted, and is not banned
		const projectRow = await database
			.select({ id: schema.project.id })
			.from(schema.project)
			.where(
				and(
					eq(schema.project.id, projectId),
					eq(schema.project.organizationId, orgId),
					isNull(schema.project.deletedAt),
					isNull(schema.project.bannedAt),
				),
			)
			.limit(1);

		if (projectRow.length === 0) {
			throw httpError(HttpErrorCode.NOT_FOUND, 'Project not found in this organization.');
		}

		// Verify target org exists and is not banned
		const targetOrgRow = await database
			.select({ id: schema.organization.id, bannedAt: schema.organization.bannedAt, deletedAt: schema.organization.deletedAt })
			.from(schema.organization)
			.where(eq(schema.organization.id, body.targetOrganizationId))
			.limit(1);

		if (targetOrgRow.length === 0 || targetOrgRow[0].deletedAt) {
			throw httpError(HttpErrorCode.NOT_FOUND, 'Target organization not found.');
		}

		if (targetOrgRow[0].bannedAt) {
			throw httpError(HttpErrorCode.FORBIDDEN, 'Target organization is restricted.');
		}

		// Check no pending transfer already exists for this project
		const existingTransfer = await database
			.select({ id: schema.projectTransfer.id })
			.from(schema.projectTransfer)
			.where(and(eq(schema.projectTransfer.projectId, projectId), eq(schema.projectTransfer.status, 'pending')))
			.limit(1);

		if (existingTransfer.length > 0) {
			throw httpError(HttpErrorCode.VALIDATION_ERROR, 'A transfer is already pending for this project.');
		}

		const now = new Date();
		const transferId = crypto.randomUUID();

		await database.insert(schema.projectTransfer).values({
			id: transferId,
			projectId,
			sourceOrganizationId: orgId,
			targetOrganizationId: body.targetOrganizationId,
			initiatedByUserId: userId,
			status: 'pending',
			createdAt: now,
		});

		return c.json({ transferId, status: 'pending' });
	})

	// GET /api/user/pending-transfers — List all pending transfers for the user's orgs
	.get('/user/pending-transfers', async (c) => {
		const { userId } = c.get('session');
		const database = drizzle(c.env.DB, { schema });

		// Get orgs where user is admin/owner
		const memberships = await database
			.select({ organizationId: schema.member.organizationId, role: schema.member.role })
			.from(schema.member)
			.innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
			.where(and(eq(schema.member.userId, userId), isNull(schema.organization.deletedAt)));

		const adminOrgIds = memberships.filter((m) => m.role === 'owner' || m.role === 'admin').map((m) => m.organizationId);

		if (adminOrgIds.length === 0) {
			return c.json({ incoming: [], outgoing: [] });
		}

		// Get all pending transfers involving user's admin orgs
		const relevantTransfers = await database
			.select()
			.from(schema.projectTransfer)
			.where(
				and(
					eq(schema.projectTransfer.status, 'pending'),
					or(
						inArray(schema.projectTransfer.sourceOrganizationId, adminOrgIds),
						inArray(schema.projectTransfer.targetOrganizationId, adminOrgIds),
					),
				),
			);

		if (relevantTransfers.length === 0) {
			return c.json({ incoming: [], outgoing: [] });
		}

		// Get project names
		const transferProjectIds = [...new Set(relevantTransfers.map((t) => t.projectId))];
		const projects = await database
			.select({ id: schema.project.id, name: schema.project.name })
			.from(schema.project)
			.where(inArray(schema.project.id, transferProjectIds));
		const projectMap = new Map(projects.map((p) => [p.id, p.name]));

		// Get org names
		const allOrgIds = [...new Set(relevantTransfers.flatMap((t) => [t.sourceOrganizationId, t.targetOrganizationId]))];
		const organizations = await database
			.select({ id: schema.organization.id, name: schema.organization.name })
			.from(schema.organization)
			.where(inArray(schema.organization.id, allOrgIds));
		const organizationMap = new Map(organizations.map((o) => [o.id, o.name]));

		const enrichTransfer = (transfer: (typeof relevantTransfers)[number]) => ({
			id: transfer.id,
			projectId: transfer.projectId,
			projectName: projectMap.get(transfer.projectId) ?? 'Unknown',
			sourceOrganizationId: transfer.sourceOrganizationId,
			sourceOrganizationName: organizationMap.get(transfer.sourceOrganizationId) ?? 'Unknown',
			targetOrganizationId: transfer.targetOrganizationId,
			targetOrganizationName: organizationMap.get(transfer.targetOrganizationId) ?? 'Unknown',
			createdAt: transfer.createdAt.toISOString(),
		});

		const incoming = relevantTransfers.filter((t) => adminOrgIds.includes(t.targetOrganizationId)).map((t) => enrichTransfer(t));

		const outgoing = relevantTransfers.filter((t) => adminOrgIds.includes(t.sourceOrganizationId)).map((t) => enrichTransfer(t));

		return c.json({ incoming, outgoing });
	})

	// POST /api/transfer/:transferId/accept — Accept a pending transfer
	.post('/transfer/:transferId/accept', async (c) => {
		const { transferId } = c.req.param();
		const { userId } = c.get('session');
		const database = drizzle(c.env.DB, { schema });

		const transferRow = await database
			.select()
			.from(schema.projectTransfer)
			.where(and(eq(schema.projectTransfer.id, transferId), eq(schema.projectTransfer.status, 'pending')))
			.limit(1);

		if (transferRow.length === 0) {
			throw httpError(HttpErrorCode.NOT_FOUND, 'Pending transfer not found.');
		}

		const transfer = transferRow[0];

		// Verify user is admin/owner of target org
		await assertOrgAdmin(database, transfer.targetOrganizationId, userId);

		// Verify project still exists, isn't soft-deleted/banned, and still belongs to source org
		const projectRow = await database
			.select({ organizationId: schema.project.organizationId, bannedAt: schema.project.bannedAt })
			.from(schema.project)
			.where(and(eq(schema.project.id, transfer.projectId), isNull(schema.project.deletedAt)))
			.limit(1);

		if (projectRow.length > 0 && projectRow[0].bannedAt) {
			throw httpError(HttpErrorCode.FORBIDDEN, 'This project has been restricted.');
		}

		if (projectRow.length === 0 || projectRow[0].organizationId !== transfer.sourceOrganizationId) {
			// Auto-cancel stale transfer
			const now = new Date();
			await database
				.update(schema.projectTransfer)
				.set({ status: 'cancelled', resolvedAt: now, resolvedByUserId: userId })
				.where(eq(schema.projectTransfer.id, transferId));
			throw httpError(HttpErrorCode.VALIDATION_ERROR, 'Project no longer exists or has been moved. Transfer cancelled.');
		}

		// Re-verify source org is not banned (may have been banned after transfer was initiated)
		const sourceOrgRow = await database
			.select({ bannedAt: schema.organization.bannedAt, deletedAt: schema.organization.deletedAt })
			.from(schema.organization)
			.where(eq(schema.organization.id, transfer.sourceOrganizationId))
			.limit(1);

		if (sourceOrgRow.length === 0 || sourceOrgRow[0].deletedAt) {
			const now = new Date();
			await database
				.update(schema.projectTransfer)
				.set({ status: 'cancelled', resolvedAt: now, resolvedByUserId: userId })
				.where(eq(schema.projectTransfer.id, transferId));
			throw httpError(HttpErrorCode.VALIDATION_ERROR, 'Source organization no longer exists. Transfer cancelled.');
		}

		if (sourceOrgRow[0].bannedAt) {
			throw httpError(HttpErrorCode.FORBIDDEN, 'Source organization has been restricted.');
		}

		// Check target org exists, is not banned, and has room (plan-based)
		const targetOrgRow = await database
			.select({ plan: schema.organization.plan, bannedAt: schema.organization.bannedAt, deletedAt: schema.organization.deletedAt })
			.from(schema.organization)
			.where(eq(schema.organization.id, transfer.targetOrganizationId))
			.limit(1);

		if (targetOrgRow.length === 0 || targetOrgRow[0].deletedAt) {
			const now = new Date();
			await database
				.update(schema.projectTransfer)
				.set({ status: 'cancelled', resolvedAt: now, resolvedByUserId: userId })
				.where(eq(schema.projectTransfer.id, transferId));
			throw httpError(HttpErrorCode.VALIDATION_ERROR, 'Target organization no longer exists. Transfer cancelled.');
		}

		if (targetOrgRow[0].bannedAt) {
			throw httpError(HttpErrorCode.FORBIDDEN, 'Target organization is restricted.');
		}

		const targetOrgMaxProjects = await getEffectiveLimit(database, {
			key: EFFECTIVE_LIMIT_ORG_MAX_PROJECTS,
			organizationId: transfer.targetOrganizationId,
			plan: targetOrgRow[0].plan ?? 'free',
		});

		const existingProjects = await database
			.select({ id: schema.project.id })
			.from(schema.project)
			.where(and(eq(schema.project.organizationId, transfer.targetOrganizationId), isNull(schema.project.deletedAt)));

		if (existingProjects.length >= targetOrgMaxProjects) {
			throw httpError(
				HttpErrorCode.VALIDATION_ERROR,
				`Target organization project limit reached (${targetOrgMaxProjects}). Upgrade the plan or remove a project.`,
			);
		}

		try {
			await filesystemNamespace
				.get(toDurableObjectId(filesystemNamespace, transfer.projectId))
				.transferProjectOwnership(transferId, userId);
		} catch (error) {
			if (readContainerCapacityError(error))
				throw httpError(
					HttpErrorCode.CONTAINER_LIMIT_REACHED,
					error instanceof Error ? error.message : 'Organization container limit reached',
				);
			throw error;
		}

		trackAuthEvent({ userId, eventType: 'project_transfer', organizationId: transfer.targetOrganizationId, request: c.req.raw });

		return c.json({ transferId, status: 'accepted' });
	})

	// POST /api/transfer/:transferId/reject — Reject a pending transfer
	.post('/transfer/:transferId/reject', async (c) => {
		const { transferId } = c.req.param();
		const { userId } = c.get('session');
		const database = drizzle(c.env.DB, { schema });

		const transferRow = await database
			.select()
			.from(schema.projectTransfer)
			.where(and(eq(schema.projectTransfer.id, transferId), eq(schema.projectTransfer.status, 'pending')))
			.limit(1);

		if (transferRow.length === 0) {
			throw httpError(HttpErrorCode.NOT_FOUND, 'Pending transfer not found.');
		}

		await assertOrgAdmin(database, transferRow[0].targetOrganizationId, userId);

		const now = new Date();
		await database
			.update(schema.projectTransfer)
			.set({ status: 'rejected', resolvedAt: now, resolvedByUserId: userId })
			.where(eq(schema.projectTransfer.id, transferId));

		return c.json({ transferId, status: 'rejected' });
	})

	// POST /api/transfer/:transferId/cancel — Cancel a pending transfer (by source org admin)
	.post('/transfer/:transferId/cancel', async (c) => {
		const { transferId } = c.req.param();
		const { userId } = c.get('session');
		const database = drizzle(c.env.DB, { schema });

		const transferRow = await database
			.select()
			.from(schema.projectTransfer)
			.where(and(eq(schema.projectTransfer.id, transferId), eq(schema.projectTransfer.status, 'pending')))
			.limit(1);

		if (transferRow.length === 0) {
			throw httpError(HttpErrorCode.NOT_FOUND, 'Pending transfer not found.');
		}

		// Verify user is admin/owner of source org
		await assertOrgAdmin(database, transferRow[0].sourceOrganizationId, userId);

		const now = new Date();
		await database
			.update(schema.projectTransfer)
			.set({ status: 'cancelled', resolvedAt: now, resolvedByUserId: userId })
			.where(eq(schema.projectTransfer.id, transferId));

		return c.json({ transferId, status: 'cancelled' });
	});

export type TransferRoutes = typeof transferRoutes;
