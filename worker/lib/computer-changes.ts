import { Buffer } from 'node:buffer';

import { z } from 'zod';

import { computerPath, projectPath } from './computer-workspace';

import type { WorkspaceLike } from './workspace-fs-adapter';

const entrySchema = z.object({
	type: z.enum(['file', 'directory', 'symlink', 'missing']),
	content: z.string().optional(),
	bytes: z.string().optional(),
	bytesPath: z.string().optional(),
	textPath: z.string().optional(),
	target: z.string().optional(),
});
type Entry = z.infer<typeof entrySchema>;

/** Keep old text baselines readable, and freeze each writer's result before FIFO handoff. */
export class ComputerChanges {
	private readonly writers = new Set<string>();
	constructor(
		private readonly storage: DurableObjectStorage,
		private readonly workspace: () => WorkspaceLike,
	) {
		storage.sql.exec(
			'CREATE TABLE IF NOT EXISTS agent_writer_change (writer_id TEXT NOT NULL, path TEXT NOT NULL, baseline TEXT, PRIMARY KEY (writer_id, path))',
		);
		const columns = storage.sql.exec<{ name: string }>('PRAGMA table_info(agent_writer_change)').toArray();
		for (const column of ['baseline_entry', 'after_entry']) {
			if (!columns.some((entry) => entry.name === column)) storage.sql.exec(`ALTER TABLE agent_writer_change ADD COLUMN ${column} TEXT`);
		}
	}

	private excluded(path: string) {
		return (
			path === '/' ||
			path
				.split('/')
				.some((part) => ['.git', '.agent', 'node_modules', '.cache', '.bun', '.next', 'dist', 'coverage', 'tmp'].includes(part))
		);
	}

	/** Resolve final and parent symlinks, including a missing write destination. */
	async resolveWritePath(path: string): Promise<string> {
		let target = projectPath(computerPath(path));
		let links = 0;
		for (;;) {
			const components = target.split('/').filter(Boolean);
			let parent = '';
			let redirected = false;
			for (const [index, component] of components.entries()) {
				const current = `${parent}/${component}`;
				const entry = await this.workspace().lstat(current);
				if (entry?.type === 'symlink') {
					if (++links > 40) throw new Error(`ELOOP: ${path}`);
					const link = await this.workspace().readlink(current);
					const destination = link.startsWith('/') ? link : `${parent}/${link}`;
					target = projectPath(computerPath(`${destination}/${components.slice(index + 1).join('/')}`));
					redirected = true;
					break;
				}
				if (!entry) return target;
				parent = current;
			}
			if (!redirected) return target;
		}
	}

	private async entry(path: string): Promise<Entry> {
		const workspace = this.workspace();
		const info = await workspace.lstat(path);
		if (!info) return { type: 'missing' };
		if (info.type === 'directory') return { type: 'directory' };
		if (info.type === 'symlink') return { type: 'symlink', target: await workspace.readlink(path) };
		const bytes = await workspace.readFileBytes(path);
		if (!bytes) throw new Error(`Cannot read baseline bytes: ${path}`);
		let text: string | undefined;
		try {
			const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
			if (!content.includes('\0')) {
				if (bytes.length <= 200_000) return { type: 'file', content };
				text = content;
			}
		} catch {
			/* Binary files are stored losslessly below. */
		}
		// SQLite rows have a size limit. Computer stores the bytes in chunks;
		// change records retain a content-addressed reference instead of base64.
		const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)));
		const hash = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
		const bytesPath = `/.agent/computer-baselines/${hash}`;
		if (!(await workspace.exists(bytesPath))) await workspace.writeFileBytes(bytesPath, bytes);
		return text === undefined ? { type: 'file', bytesPath } : { type: 'file', textPath: bytesPath };
	}

	private async encodedBytes(entry: Entry): Promise<string | undefined> {
		if (!entry.bytesPath) return entry.bytes;
		const bytes = await this.workspace().readFileBytes(entry.bytesPath);
		if (!bytes) throw new Error(`Missing durable change baseline: ${entry.bytesPath}`);
		return Buffer.from(bytes).toString('base64');
	}

	private async textContent(entry: Entry): Promise<string | undefined> {
		if (!entry.textPath) return entry.content ?? entry.target;
		const content = await this.workspace().readFile(entry.textPath);
		if (typeof content !== 'string') throw new Error(`Missing durable text baseline: ${entry.textPath}`);
		return content;
	}

	async capture(writerId: string, path: string) {
		if (this.excluded(path)) return;
		this.writers.add(writerId);
		this.storage.kv.put(`computer-change-owner:${writerId}`, true);
		if (this.storage.sql.exec('SELECT 1 FROM agent_writer_change WHERE writer_id = ? AND path = ?', writerId, path).toArray().length > 0) {
			this.storage.sql.exec(
				`UPDATE agent_writer_change SET after_entry = NULL,
				baseline_entry = COALESCE(baseline_entry, CASE WHEN baseline IS NULL THEN json_object('type', 'missing') ELSE json_object('type', 'file', 'content', baseline) END)
				WHERE writer_id = ? AND path = ?`,
				writerId,
				path,
			);
			return;
		}
		const entry = await this.entry(path);
		this.storage.sql.exec(
			'INSERT OR IGNORE INTO agent_writer_change (writer_id, path, baseline_entry) VALUES (?, ?, ?)',
			writerId,
			path,
			JSON.stringify(entry),
		);
	}

	touch(writerId: string, path: string) {
		if (this.excluded(path)) return;
		this.writers.add(writerId);
		this.storage.kv.put(`computer-change-owner:${writerId}`, true);
		this.storage.sql.exec(
			'INSERT OR IGNORE INTO agent_writer_change (writer_id, path, baseline_entry) VALUES (?, ?, ?)',
			writerId,
			path,
			JSON.stringify({ type: 'missing' }),
		);
	}

	async finish() {
		for (const writer of this.writers) {
			const rows = this.storage.sql.exec<{ path: string }>('SELECT path FROM agent_writer_change WHERE writer_id = ?', writer).toArray();
			for (const row of rows)
				this.storage.sql.exec(
					'UPDATE agent_writer_change SET after_entry = ? WHERE writer_id = ? AND path = ?',
					JSON.stringify(await this.entry(row.path)),
					writer,
					row.path,
				);
			this.storage.kv.delete(`computer-change-owner:${writer}`);
		}
		this.writers.clear();
	}

	resume(writerId: string) {
		this.writers.add(writerId);
		this.storage.kv.put(`computer-change-owner:${writerId}`, true);
	}

	async drain(writerId: string) {
		if (this.storage.kv.get(`computer-change-owner:${writerId}`)) return [];
		const rows = this.storage.sql
			.exec<{ path: string; baseline: string | null; baseline_entry: string | null; after_entry: string | null }>(
				'SELECT path, baseline, baseline_entry, after_entry FROM agent_writer_change WHERE writer_id = ?',
				writerId,
			)
			.toArray();
		const result = [];
		for (const row of rows) {
			// A newly captured row belongs to an operation still holding ownership.
			if (row.baseline_entry && !row.after_entry) continue;
			const before: Entry = row.baseline_entry
				? entrySchema.parse(JSON.parse(row.baseline_entry))
				: typeof row.baseline === 'string'
					? { type: 'file', content: row.baseline }
					: { type: 'missing' };
			const after = row.after_entry ? entrySchema.parse(JSON.parse(row.after_entry)) : await this.entry(row.path);
			if (JSON.stringify(before) === JSON.stringify(after)) {
				this.storage.sql.exec('DELETE FROM agent_writer_change WHERE writer_id = ? AND path = ?', writerId, row.path);
				continue;
			}
			const type = after.type === 'missing' ? 'delete' : before.type === 'missing' ? 'create' : 'update';
			const entryType = after.type === 'missing' ? before.type : after.type;
			if (entryType !== 'file' && entryType !== 'directory' && entryType !== 'symlink') continue;
			result.push({
				type,
				path: row.path,
				entryType,
				beforeEntryType: before.type === 'missing' ? undefined : before.type,
				beforeContent: await this.textContent(before),
				afterContent: await this.textContent(after),
				beforeBytes: await this.encodedBytes(before),
				afterBytes: await this.encodedBytes(after),
				isBinary:
					before.bytes !== undefined || after.bytes !== undefined || before.bytesPath !== undefined || after.bytesPath !== undefined,
			});
			this.storage.sql.exec('DELETE FROM agent_writer_change WHERE writer_id = ? AND path = ?', writerId, row.path);
		}
		return result;
	}
}
