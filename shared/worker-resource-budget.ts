const RESOURCE_ERROR = 'WORKER_RESOURCE_LIMIT';
export const WORKER_MODULE_BYTE_BUDGET = 2 * 1024 * 1024;
export const WORKER_GRAPH_BYTE_BUDGET = 8 * 1024 * 1024;

/** Headroom for WASM, compiler ASTs, strings, output and concurrent requests. */
export class WorkerResourceLimitError extends Error {
	constructor() {
		super(`${RESOURCE_ERROR}: Project compilation needs the container runtime`);
		this.name = 'WorkerResourceLimitError';
	}
}

export function isWorkerResourceLimit(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return /WORKER_RESOURCE_LIMIT|out of memory|memory limit|CPU time limit exceeded|WebAssembly.*(?:allocation failed|unable to allocate|could not allocate|unable to grow|memory size exceeded)|exceeded (?:its )?(?:memory|cpu(?: time)?|resource) limits?|Worker exceeded resource limits|script exceeded.*(?:memory|cpu)/i.test(
		error.message,
	);
}

/** Counts actual source bytes; package names and dependency counts play no part. */
export class WorkerBuildBudget {
	private bytes = 0;
	add(bytes: number): void {
		this.bytes += bytes;
		if (bytes > WORKER_MODULE_BYTE_BUDGET || this.bytes > WORKER_GRAPH_BYTE_BUDGET) throw new WorkerResourceLimitError();
	}
	addSource(source: string): void {
		this.add(new TextEncoder().encode(source).byteLength);
	}
}

/** Bound decoded CDN/cache bodies before materializing an oversized string. */
export async function readWorkerModule(response: Response, budget = new WorkerBuildBudget()): Promise<string> {
	if (Number(response.headers.get('Content-Length')) > WORKER_MODULE_BYTE_BUDGET) {
		await response.body?.cancel();
		throw new WorkerResourceLimitError();
	}
	if (!response.body) return '';
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let contents = '';
	let bytes = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > WORKER_MODULE_BYTE_BUDGET) throw new WorkerResourceLimitError();
			contents += decoder.decode(chunk.value, { stream: true });
		}
		budget.add(bytes);
		return contents + decoder.decode();
	} catch (error) {
		await reader.cancel().catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
}
