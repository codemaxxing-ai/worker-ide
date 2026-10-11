import type { WorkspaceOptions } from '@cloudflare/computer';

export function computerStorage(storage: DurableObjectStorage): WorkspaceOptions['storage'];
export function computerStorage(storage: unknown): unknown {
	return storage;
}
