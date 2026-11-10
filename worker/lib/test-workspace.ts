import { WorkspaceFsAdapter } from './workspace-fs-adapter';

import type { WorkspaceLike } from './workspace-fs-adapter';
import type { WorkspaceFileInfo as FileInfo, WorkspaceFileInfo as FileStat } from '@shared/workspace-file';

type Entry = { type: 'file'; bytes: Uint8Array } | { type: 'directory' } | { type: 'symlink'; target: string };

// eslint-disable-next-line unicorn/no-null -- mirrors Workspace's null-returning read API (readFile/stat return null when absent)
const MISSING = null;

/**
 * A minimal in-memory `WorkspaceLike` for tests, mirroring the durable
 * `Workspace` semantics closely enough to exercise `WorkspaceFsAdapter` and any
 * code that reads/writes the project filesystem.
 */
export class InMemoryWorkspace implements WorkspaceLike {
	private readonly entries = new Map<string, Entry>();

	private normalize(path: string): string {
		const segments: string[] = [];
		for (const part of path.split('/')) {
			if (!part || part === '.') continue;
			if (part === '..') {
				segments.pop();
				continue;
			}
			segments.push(part);
		}
		return `/${segments.join('/')}`;
	}

	private ensureParents(path: string): void {
		const parts = this.normalize(path).split('/').filter(Boolean);
		for (let index = 1; index < parts.length; index += 1) {
			const directory = `/${parts.slice(0, index).join('/')}`;
			if (!this.entries.has(directory)) this.entries.set(directory, { type: 'directory' });
		}
	}

	private info(path: string, entry: Entry): FileInfo {
		const name = path.split('/').findLast(Boolean) ?? '';
		const size = entry.type === 'file' ? entry.bytes.byteLength : 0;
		return {
			path,
			name,
			type: entry.type,
			mimeType: 'application/octet-stream',
			size,
			createdAt: 0,
			updatedAt: 0,
			target: entry.type === 'symlink' ? entry.target : undefined,
		};
	}

	async readFile(path: string): Promise<string | null> {
		const entry = this.entries.get(this.normalize(path));
		return entry?.type === 'file' ? new TextDecoder().decode(entry.bytes) : MISSING;
	}
	async readFileBytes(path: string): Promise<Uint8Array | null> {
		const entry = this.entries.get(this.normalize(path));
		return entry?.type === 'file' ? entry.bytes : MISSING;
	}
	async writeFile(path: string, content: string): Promise<void> {
		await this.writeFileBytes(path, new TextEncoder().encode(content));
	}
	async writeFileBytes(path: string, data: Uint8Array): Promise<void> {
		const target = this.normalize(path);
		this.ensureParents(target);
		this.entries.set(target, { type: 'file', bytes: data });
	}
	async appendFile(path: string, content: string): Promise<void> {
		const existing = (await this.readFile(path)) ?? '';
		await this.writeFile(path, existing + content);
	}
	async exists(path: string): Promise<boolean> {
		return this.entries.has(this.normalize(path));
	}
	async stat(path: string): Promise<FileStat | null> {
		const target = this.normalize(path);
		const entry = this.entries.get(target);
		return entry ? this.info(target, entry) : MISSING;
	}
	async lstat(path: string): Promise<FileStat | null> {
		return this.stat(path);
	}
	async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		const target = this.normalize(path);
		if (this.entries.has(target)) throw new Error(`EEXIST: path already exists: ${target}`);

		if (options?.recursive) {
			this.ensureParents(target);
		} else {
			const parent = target.slice(0, target.lastIndexOf('/')) || '/';
			if (parent !== '/' && !this.entries.has(parent)) {
				throw new Error(`ENOENT: parent directory not found: ${parent}`);
			}
		}
		this.entries.set(target, { type: 'directory' });
	}
	async readDir(path: string): Promise<FileInfo[]> {
		const base = this.normalize(path);
		const prefix = base === '/' ? '/' : `${base}/`;
		const result: FileInfo[] = [];
		const seen = new Set<string>();
		for (const [key, entry] of this.entries) {
			if (key === base || !key.startsWith(prefix)) continue;
			const remainder = key.slice(prefix.length);
			const slash = remainder.indexOf('/');
			if (slash === -1 && !seen.has(key)) {
				seen.add(key);
				result.push(this.info(key, entry));
			}
		}
		return result;
	}
	async rm(path: string, options?: { recursive?: boolean }): Promise<void> {
		const target = this.normalize(path);
		this.entries.delete(target);
		if (options?.recursive) {
			const prefix = `${target}/`;
			for (const key of this.entries.keys()) {
				if (key.startsWith(prefix)) this.entries.delete(key);
			}
		}
	}
	async cp(source: string, destination: string): Promise<void> {
		const entry = this.entries.get(this.normalize(source));
		if (entry?.type === 'file') await this.writeFileBytes(destination, entry.bytes);
	}
	async mv(source: string, destination: string): Promise<void> {
		const from = this.normalize(source);
		const entry = this.entries.get(from);
		if (!entry) return;
		this.entries.delete(from);
		const to = this.normalize(destination);
		this.ensureParents(to);
		this.entries.set(to, entry);
	}
	async symlink(target: string, linkPath: string): Promise<void> {
		const path = this.normalize(linkPath);
		this.ensureParents(path);
		this.entries.set(path, { type: 'symlink', target });
	}
	async readlink(path: string): Promise<string> {
		const entry = this.entries.get(this.normalize(path));
		if (entry?.type !== 'symlink') throw new Error(`EINVAL: ${path}`);
		return entry.target;
	}
	async glob(): Promise<FileInfo[]> {
		return [];
	}
}

/** Create an in-memory project filesystem adapter bound to a fresh workspace. */
export function createInMemoryProjectFs(virtualRoot?: string): { workspace: InMemoryWorkspace; adapter: WorkspaceFsAdapter } {
	const workspace = new InMemoryWorkspace();
	return { workspace, adapter: new WorkspaceFsAdapter(workspace, virtualRoot) };
}
