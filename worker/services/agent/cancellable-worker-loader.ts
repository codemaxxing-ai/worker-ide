/** Release the sandbox RPC capabilities when its owning tool is cancelled. */
export function cancellableWorkerLoader(loader: WorkerLoader, signal: () => AbortSignal | undefined): WorkerLoader {
	return new Proxy(loader, {
		get(target, property) {
			if (property !== 'load') return Reflect.get(target, property, target);
			return (code: WorkerLoaderWorkerCode) => {
				const worker = target.load(code);
				return new Proxy(worker, {
					get(target, property) {
						if (property !== 'getEntrypoint') return Reflect.get(target, property, target);
						return (...arguments_: Parameters<WorkerStub['getEntrypoint']>) => {
							const entrypoint = target.getEntrypoint(...arguments_);
							const abortSignal = signal();
							const abort = () => {
								disposeResource(entrypoint);
								disposeResource(worker);
							};
							abortSignal?.addEventListener('abort', abort, { once: true });
							if (abortSignal?.aborted) abort();
							return new Proxy(entrypoint, {
								get(target, property) {
									if (property === Symbol.dispose)
										return () => {
											abortSignal?.removeEventListener('abort', abort);
											disposeResource(entrypoint);
										};
									return Reflect.get(target, property, target);
								},
							});
						};
					},
				});
			};
		},
	});
}

function disposeResource(value: object): void {
	if (!(Symbol.dispose in value)) return;
	const dispose = value[Symbol.dispose];
	if (typeof dispose !== 'function') return;
	try {
		Reflect.apply(dispose, value, []);
	} catch {
		/* The execution may already have disposed this capability. */
	}
}
