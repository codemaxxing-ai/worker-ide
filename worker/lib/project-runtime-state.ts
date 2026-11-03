import { emptyRuntimeStatus } from '@shared/runtime-status';

import type { ContainerCapacity } from '@shared/container-capacity';
import type { RuntimeBackend, RuntimeDecision, RuntimePhase, RuntimeReason, RuntimeStatus, RuntimeSurface } from '@shared/runtime-status';

interface RuntimeStorage {
	get<T>(key: string): T | undefined;
	put<T>(key: string, value: T): void;
	delete(key: string): unknown;
}

/** Durable promotion and versioned status prevent stale Worker requests undoing an upgrade. */
export class ProjectRuntimeState {
	constructor(private readonly storage: RuntimeStorage) {}
	get promoted(): boolean {
		return this.promotionReason !== undefined;
	}
	get promotionReason(): RuntimeReason | undefined {
		return this.storage.get<RuntimeReason>('project-runtime-session');
	}
	promote(reason: RuntimeReason = 'resource-limit'): void {
		if (!this.promoted) this.storage.put('project-runtime-session', reason);
	}
	endSession(): void {
		const observedContainer = this.storage.get<boolean>('project-runtime-observed-container');
		const decision = this.storage.get<RuntimeDecision>('project-runtime-decision');
		this.storage.delete('project-runtime-session');
		this.storage.delete('project-runtime-promoted');
		this.storage.delete('project-runtime-observed-container');
		if (observedContainer && decision?.backend === 'container') this.select('worker', 'simple-project');
	}
	reconcile(running: boolean): void {
		if (running) {
			this.storage.put('project-runtime-observed-container', true);
			const decision = this.storage.get<RuntimeDecision>('project-runtime-decision');
			if (decision?.backend === 'container') this.promote(decision.reason);
			return;
		}
		if (this.storage.get<boolean>('project-runtime-observed-container')) this.endSession();
	}
	get alwaysUseContainer(): boolean {
		return this.storage.get<boolean>('project-always-use-container') === true;
	}
	set alwaysUseContainer(value: boolean) {
		this.storage.put('project-always-use-container', value);
	}
	select(backend: RuntimeBackend, reason: RuntimeReason): RuntimeDecision {
		const previous = this.storage.get<RuntimeDecision>('project-runtime-decision');
		if (previous?.backend === backend && previous.reason === reason) return previous;
		const decision = { backend, reason, generation: (previous?.generation ?? 0) + 1 };
		this.storage.put('project-runtime-decision', decision);
		return decision;
	}
	get status(): RuntimeStatus {
		return this.storage.get<RuntimeStatus>('project-runtime-status') ?? emptyRuntimeStatus();
	}
	update(surface: RuntimeSurface, decision: RuntimeDecision, phase: RuntimePhase, capacity?: ContainerCapacity): RuntimeStatus | undefined {
		const selected = this.storage.get<RuntimeDecision>('project-runtime-decision');
		const status = this.status;
		const previous = status[surface];
		const activeSleep = phase === 'sleeping' && previous.backend === decision.backend && previous.generation === decision.generation;
		if (selected?.generation !== decision.generation && !activeSleep) return;
		const pending = phase === 'starting' || phase === 'switching';
		if (pending && previous.phase === 'ready' && previous.backend === decision.backend && previous.generation === decision.generation)
			return;
		const next = {
			backend: pending || (surface === 'preview' && (phase === 'error' || phase === 'blocked')) ? previous.backend : decision.backend,
			target: decision.backend,
			phase: pending && previous.backend !== undefined && previous.backend !== decision.backend ? 'switching' : phase,
			reason: decision.reason,
			generation: decision.generation,
			...(capacity ? { capacity } : {}),
		};
		if (JSON.stringify(previous) === JSON.stringify(next)) return;
		const updated = { ...status, [surface]: next, revision: status.revision + 1, updatedAt: Date.now() };
		this.storage.put('project-runtime-status', updated);
		return updated;
	}
}
