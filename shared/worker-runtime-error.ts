import { isWorkerResourceLimit } from './worker-resource-budget';

export class WorkerCapabilityError extends Error {
	constructor(capability: string) {
		super(`WORKER_CAPABILITY_REQUIRED: ${capability}`);
		this.name = 'WorkerCapabilityError';
	}
}

export function workerFallbackReason(error: unknown): 'resource-limit' | 'project-requirements' | undefined {
	if (isWorkerResourceLimit(error)) return 'resource-limit';
	if (error instanceof Error && error.message.includes('WORKER_CAPABILITY_REQUIRED:')) return 'project-requirements';
}
