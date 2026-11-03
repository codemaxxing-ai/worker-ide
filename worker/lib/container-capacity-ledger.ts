import type { ContainerCapacity } from '@shared/container-capacity';

export interface ContainerReservation {
	projectId: string;
	token: string;
}

/** Synchronous storage operations keep checking capacity and reserving a slot atomic. */
export class ContainerCapacityLedger {
	constructor(private readonly storage: DurableObjectStorage['kv']) {}
	reservations(): ContainerReservation[] {
		return this.storage.get<ContainerReservation[]>('container-reservations') ?? [];
	}
	capacity(limit: number): ContainerCapacity {
		return { currentRunningContainers: this.reservations().length, maxRunningContainers: limit };
	}
	reserve(reservation: ContainerReservation, limit: number): boolean {
		const current = this.reservations();
		const previous = current.find((entry) => entry.projectId === reservation.projectId);
		if (!previous && current.length >= limit) return false;
		this.storage.put('container-reservations', [...current.filter((entry) => entry.projectId !== reservation.projectId), reservation]);
		return true;
	}
	adopt(reservation: ContainerReservation): void {
		if (this.reservations().some((entry) => entry.projectId === reservation.projectId)) return;
		this.storage.put('container-reservations', [...this.reservations(), reservation]);
	}
	release(projectId: string, token: string): boolean {
		const current = this.reservations();
		const next = current.filter((entry) => entry.projectId !== projectId || entry.token !== token);
		if (current.length === next.length) return false;
		this.storage.put('container-reservations', next);
		return true;
	}
}
