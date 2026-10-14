import { emptyRuntimeStatus } from '@shared/runtime-status';

import type { RuntimeBackend, RuntimeDecision, RuntimePhase, RuntimeReason, RuntimeStatus, RuntimeSurface } from '@shared/runtime-status';

interface RuntimeStorage {
	get<T>(key: string): T | undefined;
	put<T>(key: string, value: T): void;
}

/** Durable promotion and versioned status prevent stale Worker requests undoing an upgrade. */
export class ProjectRuntimeState {
	constructor(private readonly storage: RuntimeStorage) {}
	get promoted(): boolean {
		return this.storage.get<boolean>('project-runtime-promoted') === true;
	}
	promote(): void {
		this.storage.put('project-runtime-promoted', true);
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
	update(surface: RuntimeSurface, decision: RuntimeDecision, phase: RuntimePhase): RuntimeStatus | undefined {
		const selected = this.storage.get<RuntimeDecision>('project-runtime-decision');
		const status = this.status;
		const previous = status[surface];
		const activeSleep = phase === 'sleeping' && previous.backend === decision.backend && previous.generation === decision.generation;
		if (selected?.generation !== decision.generation && !activeSleep) return;
		const pending = phase === 'starting' || phase === 'switching';
		if (pending && previous.phase === 'ready' && previous.backend === decision.backend && previous.generation === decision.generation)
			return;
		const next = {
			backend: pending || (surface === 'preview' && phase === 'error') ? previous.backend : decision.backend,
			target: decision.backend,
			phase: pending && previous.backend !== undefined && previous.backend !== decision.backend ? 'switching' : phase,
			reason: decision.reason,
			generation: decision.generation,
		};
		if (JSON.stringify(previous) === JSON.stringify(next)) return;
		const updated = { ...status, [surface]: next, revision: status.revision + 1, updatedAt: Date.now() };
		this.storage.put('project-runtime-status', updated);
		return updated;
	}
}
