/**
 * esbuild-wasm initialization for the Vite Surface Host.
 *
 * Mirrors the auxiliary esbuild worker: esbuild runs as a precompiled
 * WebAssembly *module* (imported, not compiled from bytes), which is the only
 * form workerd permits. A single isolate-wide initialization is shared across
 * all bundling calls.
 */
import * as esbuild from 'esbuild-wasm';

import esbuildWasm from '../../../vendor/esbuild.wasm';

let initialized = false;
let initializePromise: Promise<void> | undefined;

/** Initialize esbuild-wasm once per isolate. Safe to call repeatedly. */
export async function ensureEsbuild(): Promise<typeof esbuild> {
	if (initialized) {
		return esbuild;
	}
	if (initializePromise === undefined) {
		initializePromise = (async () => {
			try {
				await esbuild.initialize({ wasmModule: esbuildWasm, worker: false });
				initialized = true;
			} catch (error) {
				if (error instanceof Error && error.message.includes('Cannot call "initialize" more than once')) {
					initialized = true;
					return;
				}
				initializePromise = undefined;
				throw error;
			}
		})();
	}
	await initializePromise;
	return esbuild;
}

export type Esbuild = typeof esbuild;
