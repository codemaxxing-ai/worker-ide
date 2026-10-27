export interface ToolFailureState {
	submissionId: string;
	fingerprint?: string;
	count: number;
	seen: string[];
	message?: string;
}

export interface ToolOutcome {
	id: string;
	toolName: string;
	input: unknown;
	error?: string;
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((entry) => canonical(entry));
	if (value && typeof value === 'object')
		return Object.fromEntries(
			Object.entries(value)
				.toSorted(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, canonical(entry)]),
		);
	return value;
}

export function toolOutputError(output: unknown): string | undefined {
	if (!output || typeof output !== 'object') return;
	if ('error' in output && output.error) return String(output.error);
	if ('exitCode' in output && typeof output.exitCode === 'number' && output.exitCode !== 0)
		return `Command exited with code ${output.exitCode}`;
	if ('metadata' in output) return toolOutputError(output.metadata);
}

/** One guard per submission; callers persist each transition before proceeding. */
export class ToolFailureGuard {
	readonly controller = new AbortController();
	private observations = 0;
	get observationVersion(): number {
		return this.observations;
	}
	constructor(
		private read: () => ToolFailureState,
		private write: (state: ToolFailureState) => void,
	) {}

	assertHealthy(): void {
		const message = this.read().message;
		if (message) throw new Error(message);
	}

	progress(): void {
		const state = this.read();
		if (!state.message && state.count > 0) this.write({ ...state, fingerprint: undefined, count: 0 });
	}

	ignore(id: string): void {
		const state = this.read();
		if (!state.seen.includes(id)) this.write({ ...state, seen: [...state.seen.slice(-255), id] });
	}

	record(outcome: ToolOutcome): void {
		const state = this.read();
		if (state.message || state.seen.includes(outcome.id)) return;
		this.observations++;
		const seen = [...state.seen.slice(-255), outcome.id];
		if (outcome.error === undefined) {
			this.write({ submissionId: state.submissionId, seen, count: 0 });
			return;
		}
		const fingerprint = JSON.stringify([outcome.toolName, canonical(outcome.input), outcome.error]);
		const count = state.fingerprint === fingerprint ? state.count + 1 : 1;
		const message = count >= 3 ? `Stopped after three repeated failures in ${outcome.toolName}: ${outcome.error.slice(0, 500)}` : undefined;
		this.write({ ...state, seen, fingerprint, count, message });
		if (message) this.controller.abort(new Error(message));
	}
}
