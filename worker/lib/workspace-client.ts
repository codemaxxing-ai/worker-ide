import { WorkspaceFsAdapter } from './workspace-fs-adapter';

import type { WorkspaceLike } from './workspace-fs-adapter';
import type { ProjectFilesystem } from '../durable/project-filesystem';
import type { FileInfo, FileStat } from '@cloudflare/shell';

/** The mount prefix the worker uses for project paths (e.g. `/project/src/a.ts`). */
export const PROJECT_ROOT = '/project';

type Stub = DurableObjectStub<ProjectFilesystem>;

/**
 * A `WorkspaceLike` that forwards every call to the project Durable Object's
 * durable `Workspace` over RPC. Worker-side paths are mounted under
 * {@link PROJECT_ROOT}; this strips that prefix before each RPC call and
 * re-adds it to returned paths, so callers operate in `/project/...` space
 * while the Workspace stores root-relative paths (`/src/a.ts`).
 */
export class WorkspaceClient implements WorkspaceLike {
	private readonly stub: Stub;
	private readonly prefix: string;
	/**
	 * Identifies the writer (agent session) behind every mutation made through
	 * this client, so the project Durable Object can attribute changes per
	 * session when multiple agents edit the same Workspace concurrently. When
	 * `undefined`, mutations are not attributed/tracked (e.g. preview, deploy,
	 * user-driven file routes).
	 */
	private readonly writerId?: string;

	constructor(stub: Stub, prefix: string = PROJECT_ROOT, writerId?: string) {
		this.stub = stub;
		this.prefix = prefix;
		this.writerId = writerId;
	}

	private strip(path: string): string {
		if (path === this.prefix) return '/';
		if (path.startsWith(`${this.prefix}/`)) return path.slice(this.prefix.length);
		return path;
	}

	private add(path: string): string {
		if (path === '/') return this.prefix;
		return `${this.prefix}${path}`;
	}

	private mapInfo<T extends FileInfo>(info: T): T {
		return { ...info, path: this.add(info.path) };
	}

	async readFile(path: string): Promise<string | null> {
		return this.stub.wsReadFile(this.strip(path));
	}
	async readFileBytes(path: string): Promise<Uint8Array | null> {
		using data = await this.stub.wsReadFileBytes(this.strip(path));
		return data ? new Uint8Array(data) : data;
	}
	async writeFile(path: string, content: string): Promise<void> {
		await this.stub.wsWriteFile(this.strip(path), content, this.writerId);
	}
	async writeFileBytes(path: string, data: Uint8Array): Promise<void> {
		await this.stub.wsWriteFileBytes(this.strip(path), data, this.writerId);
	}
	async appendFile(path: string, content: string): Promise<void> {
		await this.stub.wsAppendFile(this.strip(path), content, this.writerId);
	}
	async exists(path: string): Promise<boolean> {
		return this.stub.wsExists(this.strip(path));
	}
	async stat(path: string): Promise<FileStat | null> {
		using info = await this.stub.wsStat(this.strip(path));
		return info ? this.mapInfo(info) : info;
	}
	async lstat(path: string): Promise<FileStat | null> {
		using info = await this.stub.wsLstat(this.strip(path));
		return info ? this.mapInfo(info) : info;
	}
	async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		await this.stub.wsMkdir(this.strip(path), options?.recursive ?? false);
	}
	async readDir(path: string): Promise<FileInfo[]> {
		using entries = await this.stub.wsReadDir(this.strip(path));
		return entries.map((entry) => this.mapInfo(entry));
	}
	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		await this.stub.wsRm(this.strip(path), options?.recursive ?? false, options?.force ?? false, this.writerId);
	}
	async cp(source: string, destination: string, options?: { recursive?: boolean }): Promise<void> {
		await this.stub.wsCp(this.strip(source), this.strip(destination), options?.recursive ?? false, this.writerId);
	}
	async mv(source: string, destination: string): Promise<void> {
		await this.stub.wsMv(this.strip(source), this.strip(destination), this.writerId);
	}
	async symlink(target: string, linkPath: string): Promise<void> {
		await this.stub.wsSymlink(target, this.strip(linkPath));
	}
	async readlink(path: string): Promise<string> {
		return this.stub.wsReadlink(this.strip(path));
	}
	async glob(pattern: string): Promise<FileInfo[]> {
		using entries = await this.stub.wsGlob(this.strip(pattern));
		return entries.map((entry) => this.mapInfo(entry));
	}
}

/**
 * Build a `node:fs/promises`-compatible filesystem for a project, backed by the
 * project Durable Object's durable `Workspace`. This is the replacement for the
 * removed `worker-fs-mount` / `node:fs/promises` alias.
 */
export function createProjectFileSystem(stub: Stub, prefix: string = PROJECT_ROOT, writerId?: string): WorkspaceFsAdapter {
	return new WorkspaceFsAdapter(new WorkspaceClient(stub, prefix, writerId));
}

/** The structural type application code depends on (a subset of node:fs/promises). */
export type ProjectFileSystem = WorkspaceFsAdapter;
