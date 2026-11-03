import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import { ContainerLimitReachedError } from '@shared/container-capacity';

import { organizationContainerCapacityNamespace } from './durable-object-namespaces';
import * as schema from '../db/auth-schema';

import type { ContainerRuntimeInfo } from '@cloudflare/computer/backends/container';

const RESERVATION_KEY = 'container-capacity-reservation';
const TRANSFER_KEY = 'container-capacity-transfer';
export interface ProjectContainerReservation {
	organizationId: string;
	token: string;
}

/** All launches and ownership changes share this gate, including SDK restarts. */
export class ProjectContainerAdmission {
	private pending = 0;
	private tail: Promise<unknown> = Promise.resolve();
	private monitorGeneration = 0;
	private pendingToken?: string;

	constructor(
		private readonly state: DurableObjectState,
		private readonly environment: Env,
		private readonly projectId: string,
		private readonly onStopped: () => Promise<void>,
	) {}

	inspect() {
		return {
			running: this.state.container?.running === true,
			starting: this.pending > 0,
			pendingToken:
				this.pendingToken ?? this.state.storage.kv.get<{ destination: ProjectContainerReservation }>(TRANSFER_KEY)?.destination.token,
			reservation: this.state.storage.kv.get<ProjectContainerReservation>(RESERVATION_KEY),
		};
	}
	async exclusive<T>(operation: () => Promise<T>): Promise<T> {
		this.pending++;
		const result = this.tail.then(async () => {
			try {
				return await operation();
			} finally {
				this.pendingToken = undefined;
			}
		});
		this.tail = result.catch(() => {});
		try {
			return await result;
		} finally {
			this.pending--;
			if (!this.pending && !this.state.container?.running) await this.stopped();
		}
	}
	async reserve(organizationId: string, transferId?: string): Promise<ProjectContainerReservation> {
		const reservation = { organizationId, token: crypto.randomUUID() };
		this.pendingToken = reservation.token;
		const admission = await organizationContainerCapacityNamespace
			.getByName(`org:${organizationId}`)
			.reserve(organizationId, this.projectId, reservation.token, transferId);
		if (!admission.granted) throw new ContainerLimitReachedError(admission);
		return reservation;
	}
	async release(reservation: ProjectContainerReservation): Promise<void> {
		await organizationContainerCapacityNamespace.getByName(`org:${reservation.organizationId}`).release(this.projectId, reservation.token);
		if (this.inspect().reservation?.token === reservation.token) this.state.storage.kv.delete(RESERVATION_KEY);
	}
	setReservation(reservation: ProjectContainerReservation): void {
		this.state.storage.kv.put(RESERVATION_KEY, reservation);
	}
	async launch(operation: () => Promise<ContainerRuntimeInfo>): Promise<ContainerRuntimeInfo> {
		return this.exclusive(async () => {
			await this.reconcileTransfer();
			const [project] = await drizzle(this.environment.DB)
				.select({ organizationId: schema.project.organizationId })
				.from(schema.project)
				.where(eq(schema.project.id, this.projectId))
				.limit(1);
			if (!project) throw new Error('Project is unavailable');
			const previous = this.inspect().reservation;
			const reservation = await this.reserve(project.organizationId);
			this.monitorGeneration++;
			this.setReservation(reservation);
			if (previous && previous.organizationId !== reservation.organizationId) await this.release(previous);
			try {
				const result = await operation();
				await this.state.container?.setInactivityTimeout(120_000);
				this.watch();
				return result;
			} catch (error) {
				console.error({ event: 'container.startup-failed', projectId: this.projectId, error });
				if (this.state.container?.running) {
					this.watch();
				} else {
					await this.release(reservation);
				}
				throw error;
			}
		});
	}
	/** Restore monitoring without starting a stopped container or extending its lifetime by polling. */
	async restore(): Promise<void> {
		await this.reconcileTransfer();
		if (this.state.container?.running) {
			await this.state.container.setInactivityTimeout(120_000);
			this.watch();
			return;
		}
		await this.stopped();
	}
	private watch(): void {
		const container = this.state.container;
		if (!container?.running) return;
		const generation = ++this.monitorGeneration;
		this.state.waitUntil(
			container
				.monitor()
				.catch(() => {})
				.then(async () => {
					if (generation !== this.monitorGeneration || this.pending > 0 || container.running) return;
					await this.stopped();
				})
				.catch((error: unknown) => console.error('Container exit reconciliation failed', error)),
		);
	}
	async stopped(): Promise<void> {
		if (this.state.container?.running || this.pending > 0) return;
		const reservation = this.inspect().reservation;
		await this.onStopped();
		if (reservation) await this.release(reservation);
	}
	private async reconcileTransfer(): Promise<void> {
		const transfer = this.state.storage.kv.get<{ source?: ProjectContainerReservation; destination: ProjectContainerReservation }>(
			TRANSFER_KEY,
		);
		if (!transfer) return;
		const [project] = await drizzle(this.environment.DB)
			.select({ organizationId: schema.project.organizationId })
			.from(schema.project)
			.where(eq(schema.project.id, this.projectId))
			.limit(1);
		if (project?.organizationId === transfer.destination.organizationId) {
			this.setReservation(transfer.destination);
			if (transfer.source) await this.release(transfer.source);
		} else await this.release(transfer.destination);
		this.state.storage.kv.delete(TRANSFER_KEY);
	}
	async transfer(transferId: string, userId: string): Promise<void> {
		await this.exclusive(async () => {
			await this.reconcileTransfer();
			const database = drizzle(this.environment.DB, { schema });
			const [transfer] = await database
				.select()
				.from(schema.projectTransfer)
				.where(and(eq(schema.projectTransfer.id, transferId), eq(schema.projectTransfer.projectId, this.projectId)))
				.limit(1);
			if (transfer?.status === 'accepted') return;
			if (!transfer || transfer.status !== 'pending') throw new Error('Project transfer is unavailable');
			const source = this.inspect().reservation;
			if (this.state.container?.running) {
				const destination = await this.reserve(transfer.targetOrganizationId, transferId);
				this.state.storage.kv.put(TRANSFER_KEY, { source, destination });
			}
			try {
				const now = new Date();
				const [moved] = await database.batch([
					database
						.update(schema.project)
						.set({ organizationId: transfer.targetOrganizationId, updatedAt: now })
						.where(
							and(
								eq(schema.project.id, this.projectId),
								eq(schema.project.organizationId, transfer.sourceOrganizationId),
								sql`exists (select 1 from project_transfer where id = ${transferId} and status = 'pending')`,
							),
						)
						.returning({ id: schema.project.id }),
					database
						.update(schema.projectTransfer)
						.set({ status: 'accepted', resolvedAt: now, resolvedByUserId: userId })
						.where(
							and(
								eq(schema.projectTransfer.id, transferId),
								eq(schema.projectTransfer.status, 'pending'),
								sql`exists (select 1 from project where id = ${this.projectId} and organization_id = ${transfer.targetOrganizationId})`,
							),
						),
				]);
				if (moved.length === 0) throw new Error('Project transfer changed; retry');
			} finally {
				await this.reconcileTransfer();
			}
		});
	}
}
