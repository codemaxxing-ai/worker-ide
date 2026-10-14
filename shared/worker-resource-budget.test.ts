import { describe, expect, it, vi } from 'vitest';

import {
	isWorkerResourceLimit,
	readWorkerModule,
	WorkerBuildBudget,
	WORKER_GRAPH_BYTE_BUDGET,
	WORKER_MODULE_BYTE_BUDGET,
	WorkerResourceLimitError,
} from './worker-resource-budget';

describe('Worker compilation headroom', () => {
	it('counts UTF-8 bytes rather than characters or dependency names', () => {
		const budget = new WorkerBuildBudget();
		budget.addSource('é'.repeat(WORKER_MODULE_BYTE_BUDGET / 2));
		expect(() => new WorkerBuildBudget().addSource('é'.repeat(WORKER_MODULE_BYTE_BUDGET / 2 + 1))).toThrow(WorkerResourceLimitError);
	});
	it('limits a graph of individually small modules', () => {
		const budget = new WorkerBuildBudget();
		for (let index = 0; index < WORKER_GRAPH_BYTE_BUDGET / WORKER_MODULE_BYTE_BUDGET; index++) budget.add(WORKER_MODULE_BYTE_BUDGET);
		expect(() => budget.add(1)).toThrow(WorkerResourceLimitError);
	});
	it('cancels oversized streamed responses without a content length', async () => {
		const cancel = vi.fn();
		const response = new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(new Uint8Array(WORKER_MODULE_BYTE_BUDGET + 1));
				},
				cancel,
			}),
		);
		await expect(readWorkerModule(response)).rejects.toThrow(WorkerResourceLimitError);
		expect(cancel).toHaveBeenCalledOnce();
	});
	it('rejects declared oversized bodies before decoding', async () => {
		const cancel = vi.fn();
		const response = new Response(new ReadableStream({ cancel }), { headers: { 'Content-Length': String(WORKER_MODULE_BYTE_BUDGET + 1) } });
		await expect(readWorkerModule(response)).rejects.toThrow(WorkerResourceLimitError);
		expect(cancel).toHaveBeenCalledOnce();
	});
	it('decodes split multibyte sequences and shares the graph budget', async () => {
		const bytes = new TextEncoder().encode('é');
		const response = new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(bytes.slice(0, 1));
					controller.enqueue(bytes.slice(1));
					controller.close();
				},
			}),
		);
		const budget = new WorkerBuildBudget();
		budget.add(WORKER_MODULE_BYTE_BUDGET);
		budget.add(WORKER_MODULE_BYTE_BUDGET);
		budget.add(WORKER_MODULE_BYTE_BUDGET);
		budget.add(WORKER_MODULE_BYTE_BUDGET - 2);
		expect(await readWorkerModule(response, budget)).toBe('é');
		expect(() => budget.add(1)).toThrow(WorkerResourceLimitError);
	});
	it.each([
		'Worker exceeded resource limits',
		'CPU time limit exceeded',
		'Worker exceeded its CPU time limit',
		'WebAssembly.Memory.grow(): Maximum memory size exceeded',
		'out of memory',
		'WORKER_RESOURCE_LIMIT: compilation',
	])('recognizes platform resource failures: %s', (message) => {
		expect(isWorkerResourceLimit(new Error(message))).toBe(true);
	});
	it.each(['Unexpected token', 'Package not found', 'Cannot resolve dependency', 'Project changed while preparing the preview'])(
		'preserves normal errors: %s',
		(message) => {
			expect(isWorkerResourceLimit(new Error(message))).toBe(false);
		},
	);
});
