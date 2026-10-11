import { Buffer } from 'node:buffer';

import type { FileInfo, FileStat } from '@cloudflare/shell';

/**
 * The minimal subset of `@cloudflare/shell`'s `Workspace` that the node:fs-style
 * adapter needs. A concrete `Workspace` (inside the Durable Object) satisfies
 * this directly; a cross-DO RPC proxy (`WorkspaceClient`, on the worker side)
 * implements the same shape by forwarding each call to the project DO.
 */
export interface WorkspaceLike {
	readFile(path: string): Promise<string | null>;
	readFileBytes(path: string): Promise<Uint8Array | null>;
	writeFile(path: string, content: string): Promise<void>;
	writeFileBytes(path: string, data: Uint8Array): Promise<void>;
	appendFile(path: string, content: string): Promise<void>;
	exists(path: string): Promise<boolean>;
	stat(path: string): Promise<(FileStat & { mode?: number }) | null>;
	lstat(path: string): Promise<(FileStat & { mode?: number }) | null>;
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
	readDir(path: string): Promise<FileInfo[]>;
	rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
	cp(source: string, destination: string, options?: { recursive?: boolean }): Promise<void>;
	mv(source: string, destination: string): Promise<void>;
	symlink(target: string, linkPath: string): Promise<void>;
	readlink(path: string): Promise<string>;
	glob(pattern: string): Promise<FileInfo[]>;
	chmod?(path: string, mode: number): Promise<void>;
}

type EntryType = 'file' | 'directory' | 'symlink';

function errno(code: string, message: string): NodeJS.ErrnoException {
	const error: NodeJS.ErrnoException = new Error(`${code}: ${message}`);
	error.code = code;
	return error;
}

function normalizeWorkspaceError(error: unknown): unknown {
	if (!(error instanceof Error)) return error;
	if ('code' in error && typeof error.code === 'string') return error;

	const code = /^([A-Z]+):/.exec(error.message)?.[1];
	if (!code) return error;
	return errno(code, error.message.slice(code.length + 1).trimStart());
}

/** A node:fs `Dirent`-compatible directory entry. */
export class WorkspaceDirent {
	readonly name: string;
	private readonly entryType: EntryType;

	constructor(name: string, entryType: EntryType) {
		this.name = name;
		this.entryType = entryType;
	}

	isFile(): boolean {
		return this.entryType === 'file';
	}
	isDirectory(): boolean {
		return this.entryType === 'directory';
	}
	isSymbolicLink(): boolean {
		return this.entryType === 'symlink';
	}
	isBlockDevice(): boolean {
		return false;
	}
	isCharacterDevice(): boolean {
		return false;
	}
	isFIFO(): boolean {
		return false;
	}
	isSocket(): boolean {
		return false;
	}
}

/** A node:fs `Stats`-compatible object built from a `Workspace` `FileStat`. */
export class WorkspaceStats {
	readonly size: number;
	readonly mtimeMs: number;
	readonly ctimeMs: number;
	readonly birthtimeMs: number;
	readonly mode: number;
	readonly dev = 0;
	readonly ino = 0;
	readonly uid = 0;
	readonly gid = 0;
	readonly nlink = 1;
	private readonly entryType: EntryType;

	constructor(stat: FileStat & { mode?: number }) {
		this.entryType = stat.type;
		this.size = stat.size;
		this.mtimeMs = stat.updatedAt;
		this.ctimeMs = stat.updatedAt;
		this.birthtimeMs = stat.createdAt;
		this.mode = stat.mode ?? (stat.type === 'directory' ? 0o4_0000 : stat.type === 'symlink' ? 0o12_0000 : 0o10_0644);
	}

	get mtime(): Date {
		return new Date(this.mtimeMs);
	}
	get ctime(): Date {
		return new Date(this.ctimeMs);
	}
	get birthtime(): Date {
		return new Date(this.birthtimeMs);
	}
	isFile(): boolean {
		return this.entryType === 'file';
	}
	isDirectory(): boolean {
		return this.entryType === 'directory';
	}
	isSymbolicLink(): boolean {
		return this.entryType === 'symlink';
	}
	isBlockDevice(): boolean {
		return false;
	}
	isCharacterDevice(): boolean {
		return false;
	}
	isFIFO(): boolean {
		return false;
	}
	isSocket(): boolean {
		return false;
	}
}

type ReadFileOptions = string | { encoding?: string | null } | undefined;
type WriteData = string | Uint8Array | ArrayBuffer;

function encodingOf(options: ReadFileOptions): string | undefined {
	if (typeof options === 'string') return options;
	return options?.encoding ?? undefined;
}

function toBytes(data: WriteData): Uint8Array {
	if (typeof data === 'string') return new TextEncoder().encode(data);
	if (data instanceof Uint8Array) return data;
	return new Uint8Array(data);
}

/**
 * A `node:fs/promises`-compatible filesystem backed by a `WorkspaceLike`.
 *
 * This is the single adapter that replaces both the old in-memory git
 * filesystem (`MemoryFs`) and the `worker-fs-mount`/`node:fs/promises` shim.
 * It is used by isomorphic-git inside the Durable Object, and by application
 * code on the worker side via a cross-DO RPC `WorkspaceClient`.
 */
export class WorkspaceFsAdapter {
	private readonly ws: WorkspaceLike;
	private readonly virtualRoot: string;
	/** Self-reference so isomorphic-git's `fs.promises` access works. */
	readonly promises: WorkspaceFsAdapter;

	constructor(ws: WorkspaceLike, virtualRoot = '/') {
		this.ws = ws;
		this.virtualRoot = this.normalizePath(virtualRoot);
		this.promises = this;
	}

	private normalizePath(input: string): string {
		const segments: string[] = [];
		for (const part of input.split('/')) {
			if (!part || part === '.') continue;
			if (part === '..') {
				segments.pop();
				continue;
			}
			segments.push(part);
		}
		return `/${segments.join('/')}`;
	}

	private normalize(input: string): string {
		const normalized = this.normalizePath(input);
		if (this.virtualRoot === '/' || normalized === this.virtualRoot) return normalized === this.virtualRoot ? '/' : normalized;

		const virtualPrefix = `${this.virtualRoot}/`;
		return normalized.startsWith(virtualPrefix) ? normalized.slice(this.virtualRoot.length) : normalized;
	}

	async readFile(path: string, options: { encoding: BufferEncoding } | BufferEncoding): Promise<string>;
	async readFile(path: string, options?: { encoding?: null } | null): Promise<Buffer>;
	async readFile(path: string, options?: ReadFileOptions | null): Promise<string | Buffer>;
	async readFile(path: string, options?: ReadFileOptions | null): Promise<string | Buffer> {
		const target = this.normalize(path);
		const encoding = encodingOf(options ?? undefined);
		if (encoding) {
			const text = await this.ws.readFile(target);
			if (text === null) throw errno('ENOENT', target);
			return text;
		}
		const bytes = await this.ws.readFileBytes(target);
		if (bytes === null) throw errno('ENOENT', target);
		return Buffer.from(bytes);
	}

	async writeFile(path: string, data: WriteData, options?: { encoding?: string }): Promise<void> {
		const target = this.normalize(path);
		if (typeof data === 'string' && options?.encoding !== 'binary') {
			await this.ws.writeFile(target, data);
			return;
		}
		await this.ws.writeFileBytes(target, toBytes(data));
	}

	async appendFile(path: string, data: WriteData): Promise<void> {
		const target = this.normalize(path);
		const text = typeof data === 'string' ? data : new TextDecoder().decode(toBytes(data));
		await this.ws.appendFile(target, text);
	}

	async readdir(path: string, options: { withFileTypes: true; recursive?: boolean }): Promise<WorkspaceDirent[]>;
	async readdir(path: string, options?: { withFileTypes?: false; recursive?: boolean }): Promise<string[]>;
	async readdir(path: string, options?: { withFileTypes?: boolean; recursive?: boolean }): Promise<string[] | WorkspaceDirent[]>;
	async readdir(path: string, options?: { withFileTypes?: boolean; recursive?: boolean }): Promise<string[] | WorkspaceDirent[]> {
		const target = this.normalize(path);
		if (options?.recursive) {
			const names = await this.walk(target, '');
			return names;
		}
		const entries = await this.ws.readDir(target);
		if (options?.withFileTypes) {
			return entries.map((entry) => new WorkspaceDirent(entry.name, entry.type));
		}
		return entries.map((entry) => entry.name);
	}

	private async walk(root: string, prefix: string): Promise<string[]> {
		const base = prefix ? `${root}/${prefix}` : root;
		const entries = await this.ws.readDir(base);
		const result: string[] = [];
		for (const entry of entries) {
			const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
			result.push(relative);
			if (entry.type === 'directory') {
				result.push(...(await this.walk(root, relative)));
			}
		}
		return result;
	}

	async mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined> {
		try {
			await this.ws.mkdir(this.normalize(path), { recursive: options?.recursive ?? false });
		} catch (error) {
			throw normalizeWorkspaceError(error);
		}
		return undefined;
	}

	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		await this.ws.rm(this.normalize(path), { recursive: options?.recursive ?? false, force: options?.force ?? false });
	}

	async rmdir(path: string): Promise<void> {
		await this.ws.rm(this.normalize(path), { recursive: true, force: true });
	}

	async unlink(path: string): Promise<void> {
		await this.ws.rm(this.normalize(path), { force: true });
	}

	async rename(source: string, destination: string): Promise<void> {
		await this.ws.mv(this.normalize(source), this.normalize(destination));
	}

	async cp(source: string, destination: string, options?: { recursive?: boolean }): Promise<void> {
		await this.ws.cp(this.normalize(source), this.normalize(destination), { recursive: options?.recursive ?? false });
	}

	async copyFile(source: string, destination: string): Promise<void> {
		await this.ws.cp(this.normalize(source), this.normalize(destination));
	}

	private rootStat(): WorkspaceStats {
		return new WorkspaceStats({
			path: '/',
			name: '',
			type: 'directory',
			mimeType: 'inode/directory',
			size: 0,
			createdAt: 0,
			updatedAt: 0,
		});
	}

	async stat(path: string): Promise<WorkspaceStats> {
		const target = this.normalize(path);
		if (target === '/') return this.rootStat();
		const info = await this.ws.stat(target);
		if (!info) throw errno('ENOENT', path);
		return new WorkspaceStats(info);
	}

	async lstat(path: string): Promise<WorkspaceStats> {
		const target = this.normalize(path);
		if (target === '/') return this.rootStat();
		const info = await this.ws.lstat(target);
		if (!info) throw errno('ENOENT', path);
		return new WorkspaceStats(info);
	}

	async access(path: string): Promise<void> {
		const exists = await this.ws.exists(this.normalize(path));
		if (!exists) throw errno('ENOENT', path);
	}

	async symlink(target: string, path: string): Promise<void> {
		await this.ws.symlink(target, this.normalize(path));
	}

	async readlink(path: string): Promise<string> {
		return this.ws.readlink(this.normalize(path));
	}

	async realpath(path: string): Promise<string> {
		return this.normalize(path);
	}

	async chmod(path: string, mode: number): Promise<void> {
		await this.ws.chmod?.(this.normalize(path), mode);
	}

	async utimes(_path: string, _atime: Date | number, _mtime: Date | number): Promise<void> {
		// no-op
	}
}
