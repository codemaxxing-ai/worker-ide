import { z } from 'zod';

export const runtimeBackendSchema = z.enum(['worker', 'container']);
export type RuntimeBackend = z.infer<typeof runtimeBackendSchema>;
export const runtimeReasonSchema = z.enum(['simple-project', 'project-requirements', 'explicit-choice', 'resource-limit']);
export type RuntimeReason = z.infer<typeof runtimeReasonSchema>;
export interface RuntimeDecision {
	backend: RuntimeBackend;
	reason: RuntimeReason;
	generation: number;
}

const runtimeSurfaceSchema = z.object({
	backend: runtimeBackendSchema.optional(),
	target: runtimeBackendSchema.optional(),
	phase: z.enum(['idle', 'starting', 'switching', 'ready', 'sleeping', 'error']),
	reason: runtimeReasonSchema.optional(),
	generation: z.number(),
});
export const runtimeStatusSchema = z.object({
	preview: runtimeSurfaceSchema,
	build: runtimeSurfaceSchema,
	revision: z.number(),
	updatedAt: z.number(),
});
export type RuntimeStatus = z.infer<typeof runtimeStatusSchema>;
export type RuntimeSurface = 'preview' | 'build';
export type RuntimePhase = RuntimeStatus['preview']['phase'];

export function emptyRuntimeStatus(): RuntimeStatus {
	return { preview: { phase: 'idle', generation: 0 }, build: { phase: 'idle', generation: 0 }, revision: 0, updatedAt: 0 };
}
