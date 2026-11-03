import { z } from 'zod';

export const containerCapacitySchema = z.object({
	currentRunningContainers: z.number().int().nonnegative(),
	maxRunningContainers: z.number().int().nonnegative(),
});
export type ContainerCapacity = z.infer<typeof containerCapacitySchema>;

/** The tagged message survives Worker RPC and Computer's error wrappers. */
export class ContainerLimitReachedError extends Error {
	constructor(capacity: ContainerCapacity) {
		super(
			`CONTAINER_LIMIT_REACHED: Organization container limit reached (${capacity.currentRunningContainers}/${capacity.maxRunningContainers}). Retry when a container stops.`,
		);
		this.name = 'ContainerLimitReachedError';
	}
}

export function readContainerCapacityError(error: unknown): ContainerCapacity | undefined {
	if (!(error instanceof Error)) return;
	const match = /CONTAINER_LIMIT_REACHED: Organization container limit reached \((\d+)\/(\d+)\)/.exec(error.message);
	if (!match) return;
	const parsed = containerCapacitySchema.safeParse({ currentRunningContainers: Number(match[1]), maxRunningContainers: Number(match[2]) });
	return parsed.success ? parsed.data : undefined;
}
