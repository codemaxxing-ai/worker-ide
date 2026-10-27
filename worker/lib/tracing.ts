import { AsyncLocalStorage } from 'node:async_hooks';

import { tracing } from 'cloudflare:workers';

export type SpanAttributeValue = string | number | boolean;

export type SpanAttributes = Record<string, SpanAttributeValue | undefined>;

export interface TracingSpan {
	setAttribute(key: string, value: SpanAttributeValue): void;
	readonly isTraced?: boolean;
}

const noopSpan: TracingSpan = {
	setAttribute() {},
	isTraced: false,
};

/**
 * Explicit tracing handle for execution contexts that supply `ctx.tracing`.
 *
 * Older runtimes leave the global unbound in WorkerEntrypoint RPC methods,
 * including `VITE_HOST.build`. Passing `ctx.tracing` to {@link runWithTracing}
 * lets nested build spans record under that invocation. The explicit handle
 * also takes precedence when newer runtimes expose a global tracing handle.
 */
const tracingContext = new AsyncLocalStorage<Tracing | undefined>();

/**
 * Establish an explicit tracing handle for the duration of `function_`, so any
 * nested {@link withSpan} calls record spans even when the `cloudflare:workers`
 * `tracing` global is not bound (RPC entrypoint methods). Pass `ctx.tracing`
 * from the entrypoint. A no-op when the handle is `undefined`.
 */
export function runWithTracing<R>(handle: Tracing | undefined, function_: () => R): R {
	if (handle === undefined) {
		return function_();
	}
	return tracingContext.run(handle, function_);
}

/** Prefer an explicitly supplied handle over the runtime's global handle. */
function activeTracing(): Tracing | undefined {
	return tracingContext.getStore() ?? tracing;
}

function applyAttributes(span: TracingSpan, attributes?: SpanAttributes): void {
	if (attributes === undefined) {
		return;
	}
	for (const [key, value] of Object.entries(attributes)) {
		if (value !== undefined) {
			span.setAttribute(key, value);
		}
	}
}

export async function withSpan<T>(name: string, run: (span: TracingSpan) => T | Promise<T>, attributes?: SpanAttributes): Promise<T> {
	const handle = activeTracing();
	const enterSpan = handle?.enterSpan?.bind(handle);
	if (typeof enterSpan !== 'function') {
		return run(noopSpan);
	}
	return enterSpan(name, (span: TracingSpan) => {
		applyAttributes(span, attributes);
		return run(span);
	});
}
