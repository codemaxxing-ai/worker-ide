import { DurableObject } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import { EFFECTIVE_LIMIT_ORG_MAX_RUNNING_CONTAINERS } from '@shared/limits';

import * as schema from '../db/auth-schema';
import { ContainerCapacityLedger } from '../lib/container-capacity-ledger';
import { filesystemNamespace } from '../lib/durable-object-namespaces';
import { getEffectiveLimit } from '../lib/limits';
import { toDurableObjectId } from '../lib/project-id';

/** One admission authority per organization; idle accounting never wakes containers. */
export class OrganizationContainerCapacity extends DurableObject<Env> {
	private initialization?: Promise<void>;
	private get ledger(): ContainerCapacityLedger {
		return new ContainerCapacityLedger(this.ctx.storage.kv);
	}
	private async initialize(organizationId: string): Promise<void> {
		const previous = this.ctx.storage.kv.get<string>('organization-id');
		if (previous && previous !== organizationId) throw new Error('Organization capacity scope mismatch');
		this.ctx.storage.kv.put('organization-id', organizationId);
		if (this.ctx.storage.kv.get<boolean>('containers-adopted')) return;
		this.initialization ??= (async () => {
			const projects = await drizzle(this.env.DB)
				.select({ id: schema.project.id })
				.from(schema.project)
				.where(eq(schema.project.organizationId, organizationId));
			for (let offset = 0; offset < projects.length; offset += 10) {
				await Promise.all(
					projects.slice(offset, offset + 10).map(async ({ id }) => {
						const snapshot = await filesystemNamespace.get(toDurableObjectId(filesystemNamespace, id)).inspectContainerAllocation();
						if (snapshot.running)
							this.ledger.adopt({
								projectId: id,
								token: snapshot.reservation?.organizationId === organizationId ? snapshot.reservation.token : crypto.randomUUID(),
							});
					}),
				);
			}
			this.ctx.storage.kv.put('containers-adopted', true);
		})().finally(() => {
			this.initialization = undefined;
		});
		await this.initialization;
	}
	private async reconcile(): Promise<void> {
		await Promise.all(
			this.ledger.reservations().map(async (reservation) => {
				try {
					const snapshot = await filesystemNamespace
						.get(toDurableObjectId(filesystemNamespace, reservation.projectId))
						.inspectContainerAllocation();
					const organizationId = this.ctx.storage.kv.get<string>('organization-id');
					if (
						snapshot.pendingToken !== reservation.token &&
						(!snapshot.running || (snapshot.reservation && snapshot.reservation.organizationId !== organizationId))
					)
						this.release(reservation.projectId, reservation.token);
				} catch {
					// An unavailable owner is not proof that its container stopped.
				}
			}),
		);
	}
	async status(organizationId: string) {
		await this.initialize(organizationId);
		await this.reconcile();
		const limit = await getEffectiveLimit(drizzle(this.env.DB, { schema }), {
			key: EFFECTIVE_LIMIT_ORG_MAX_RUNNING_CONTAINERS,
			organizationId,
		});
		return this.ledger.capacity(limit);
	}
	async reserve(organizationId: string, projectId: string, token: string, transferId?: string) {
		await this.initialize(organizationId);
		const database = drizzle(this.env.DB, { schema });
		const [project] = await database.select().from(schema.project).where(eq(schema.project.id, projectId)).limit(1);
		if (!project || project.deletedAt || project.bannedAt) throw new Error('Project is unavailable');
		if (project.organizationId !== organizationId) {
			if (!transferId) throw new Error('Project organization changed');
			const [transfer] = await database
				.select()
				.from(schema.projectTransfer)
				.where(
					and(
						eq(schema.projectTransfer.id, transferId),
						eq(schema.projectTransfer.projectId, projectId),
						eq(schema.projectTransfer.status, 'pending'),
					),
				)
				.limit(1);
			if (transfer?.sourceOrganizationId !== project.organizationId || transfer.targetOrganizationId !== organizationId)
				throw new Error('Project transfer is unavailable');
		}
		const [organization] = await database.select().from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
		if (!organization || organization.deletedAt || organization.bannedAt) throw new Error('Organization is unavailable');
		const limit = await getEffectiveLimit(database, { key: EFFECTIVE_LIMIT_ORG_MAX_RUNNING_CONTAINERS, organizationId });
		if (this.ledger.capacity(limit).currentRunningContainers >= limit) await this.reconcile();
		const granted = this.ledger.reserve({ projectId, token }, limit);
		if (!granted) console.info({ event: 'container.capacity-denied', organizationId, projectId, ...this.ledger.capacity(limit) });
		return { granted, ...this.ledger.capacity(limit) };
	}
	release(projectId: string, token: string): void {
		if (this.ledger.release(projectId, token))
			console.info({ event: 'container.slot-released', organizationId: this.ctx.storage.kv.get('organization-id'), projectId });
	}
}
