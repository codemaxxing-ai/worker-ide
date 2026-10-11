import { ComputerWorkspace, computerPath, projectPath } from './computer-workspace';

import type { Workspace } from '@cloudflare/shell';

export interface ComputerMigrationStatus {
	phase: 'copy' | 'verify' | 'complete' | 'failed';
	cursor: string;
	copied: number;
	error?: string;
}

const STATUS_KEY = 'computer-migration-v1';
const STORE_KEY = 'project-active-store';
const BATCH_SIZE = 25;

export class ComputerMigration {
	constructor(
		private readonly storage: DurableObjectStorage,
		private readonly legacy: Workspace,
		private readonly destination: ComputerWorkspace,
	) {}

	get active(): boolean {
		return this.storage.kv.get<string>(STORE_KEY) === 'computer';
	}

	status(): ComputerMigrationStatus {
		return this.storage.kv.get<ComputerMigrationStatus>(STATUS_KEY) ?? { phase: 'copy', cursor: '', copied: 0 };
	}

	async retry(): Promise<void> {
		const status = this.status();
		if (status.phase !== 'failed') return;
		// A failed migration may have served later legacy writes. Discard only the
		// unverified Computer copy before retrying; legacy recovery data stays intact.
		await this.destination.rm('/', { recursive: true, force: true });
		this.storage.kv.put(STATUS_KEY, { phase: 'copy', cursor: '', copied: 0 });
	}

	async batch(): Promise<boolean> {
		if (this.active) return true;
		const status = this.status();
		if (status.phase === 'failed') throw new Error(status.error);
		try {
			await this.legacy.lstat('/');
			await this.destination.mkdir('/', { recursive: true });
			const rows = this.storage.sql
				.exec<{ path: string }>('SELECT path FROM cf_workspace_default WHERE path > ? ORDER BY path LIMIT ?', status.cursor, BATCH_SIZE)
				.toArray();
			for (const row of rows) {
				await (status.phase === 'copy' ? this.copy(row.path) : this.verify(row.path));
				status.cursor = row.path;
				status.copied++;
				this.storage.kv.put(STATUS_KEY, status);
			}
			if (rows.length === BATCH_SIZE) return false;
			if (status.phase === 'copy') {
				this.storage.kv.put(STATUS_KEY, { phase: 'verify', cursor: '', copied: status.copied });
				return false;
			}
			const legacyEntries = await this.legacy._getAllPaths();
			const destinationEntries = await this.destination._getAllPaths();
			const legacyPaths = legacyEntries.toSorted();
			const copiedPaths = destinationEntries.toSorted();
			if (JSON.stringify(legacyPaths) !== JSON.stringify(copiedPaths)) throw new Error('Copied tree contains missing or extra entries');
			this.storage.transactionSync(() => {
				this.storage.kv.put(STATUS_KEY, { ...status, phase: 'complete' });
				this.storage.kv.put(STORE_KEY, 'computer');
			});
			return true;
		} catch (error) {
			const message = `Computer migration failed: ${error instanceof Error ? error.message : String(error)}. Legacy SQLite and R2 data remain intact. Retry migration after restoring missing blobs or freeing capacity.`;
			this.storage.kv.put(STATUS_KEY, { ...status, phase: 'failed', error: message });
			throw new Error(message, { cause: error });
		}
	}

	private async copy(path: string): Promise<void> {
		const info = await this.legacy.lstat(path);
		if (!info) throw new Error(`Missing legacy entry: ${path}`);
		if (info.type === 'directory') {
			await this.destination.mkdir(path, { recursive: true });
			return;
		}
		await this.destination.rm(path, { force: true });
		if (info.type === 'symlink') {
			await this.destination.symlink(await this.legacy.readlink(path), path);
			return;
		}
		const bytes = await this.legacy.readFileBytes(path);
		if (!bytes || bytes.byteLength !== info.size) throw new Error(`Missing or truncated legacy blob: ${path}`);
		await this.destination.writeFileBytes(path, bytes);
	}

	private async verify(path: string): Promise<void> {
		const source = await this.legacy.lstat(path);
		const copied = await this.destination.lstat(path);
		if (!source || !copied || source.type !== copied.type) throw new Error(`Entry verification failed: ${path}`);
		if (source.type === 'directory') return;
		if (source.type === 'symlink') {
			const originalTarget = await this.legacy.readlink(path);
			const expectedTarget = originalTarget.startsWith('/') ? projectPath(computerPath(originalTarget)) : originalTarget;
			if (expectedTarget !== (await this.destination.readlink(path))) throw new Error(`Symlink verification failed: ${path}`);
			return;
		}
		const originalBytes = await this.legacy.readFileBytes(path);
		const copiedBytes = await this.destination.readFileBytes(path);
		if (
			!originalBytes ||
			!copiedBytes ||
			originalBytes.length !== copiedBytes.length ||
			originalBytes.some((byte, index) => byte !== copiedBytes[index])
		) {
			throw new Error(`Byte verification failed: ${path}`);
		}
	}
}
