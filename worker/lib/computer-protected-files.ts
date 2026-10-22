import { Buffer } from 'node:buffer';

import { z } from 'zod';

import { PROTECTED_SYSTEM_FILES } from '@shared/constants';

import { resolveWorkspacePath } from './resolve-workspace-path';

import type { WorkspaceLike } from './workspace-fs-adapter';

const entrySchema = z.object({
	type: z.enum(['missing', 'file', 'symlink', 'directory']),
	bytes: z.string().optional(),
	target: z.string().optional(),
	mode: z.number().optional(),
});
const snapshotSchema = z.record(z.string(), entrySchema);
type Entry = z.infer<typeof entrySchema>;

/** Native processes cannot commit changes to IDE-managed configuration. */
export class ComputerProtectedFiles {
	constructor(
		private storage: DurableObjectStorage,
		private workspace: WorkspaceLike,
	) {
		storage.sql.exec(
			'CREATE TABLE IF NOT EXISTS computer_protected_files (execution_id TEXT NOT NULL, part INTEGER NOT NULL, content TEXT NOT NULL, PRIMARY KEY (execution_id, part))',
		);
	}

	private async entry(path: string): Promise<Entry> {
		const info = await this.workspace.lstat(path);
		if (!info) return { type: 'missing' };
		if (info.type === 'symlink') return { type: 'symlink', target: await this.workspace.readlink(path) };
		if (info.type === 'directory') return { type: 'directory' };
		const bytes = await this.workspace.readFileBytes(path);
		if (!bytes) throw new Error(`Cannot preserve protected file: ${path}`);
		return { type: 'file', bytes: Buffer.from(bytes).toString('base64'), mode: info.mode };
	}

	async capture(executionId: string): Promise<void> {
		if (this.storage.sql.exec('SELECT 1 FROM computer_protected_files WHERE execution_id = ? LIMIT 1', executionId).toArray().length > 0)
			return;
		const snapshot: Record<string, Entry> = {};
		const paths = new Set(PROTECTED_SYSTEM_FILES);
		for (const path of PROTECTED_SYSTEM_FILES) paths.add(await resolveWorkspacePath(this.workspace, path));
		for (const path of paths) {
			const entry = await this.entry(path);
			if (entry.type === 'directory') throw new Error(`Protected configuration is a directory: ${path}`);
			snapshot[path] = entry;
		}
		const content = JSON.stringify(snapshot);
		this.storage.transactionSync(() => {
			for (let offset = 0; offset < content.length; offset += 64_000) {
				this.storage.sql.exec(
					'INSERT INTO computer_protected_files (execution_id, part, content) VALUES (?, ?, ?)',
					executionId,
					offset / 64_000,
					content.slice(offset, offset + 64_000),
				);
			}
		});
	}

	async restore(executionId: string): Promise<string[]> {
		const parts = this.storage.sql
			.exec<{ content: string }>('SELECT content FROM computer_protected_files WHERE execution_id = ? ORDER BY part', executionId)
			.toArray();
		// Executions started before this guard was deployed have no saved baseline.
		if (parts.length === 0) return [];
		const snapshot = snapshotSchema.parse(JSON.parse(parts.map((part) => part.content).join('')));
		const changed: string[] = [];
		for (const [path, before] of Object.entries(snapshot)) {
			if (JSON.stringify(before) === JSON.stringify(await this.entry(path))) continue;
			await this.workspace.rm(path, { recursive: true, force: true });
			if (before.type === 'file' && before.bytes !== undefined) {
				await this.workspace.writeFileBytes(path, new Uint8Array(Buffer.from(before.bytes, 'base64')));
				if (before.mode !== undefined) await this.workspace.chmod?.(path, before.mode);
			} else if (before.type === 'symlink' && before.target !== undefined) {
				await this.workspace.symlink(before.target, path);
			}
			changed.push(path);
		}
		return changed;
	}

	clear(executionId: string): void {
		this.storage.sql.exec('DELETE FROM computer_protected_files WHERE execution_id = ?', executionId);
	}
}
