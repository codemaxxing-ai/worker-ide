import { minimatch } from 'minimatch';

import { getContentType } from './content-type';

import type { WorkspaceLike } from './workspace-fs-adapter';
import type { Workspace } from '@cloudflare/computer';
import type { FileInfo, FileStat } from '@cloudflare/shell';

export const COMPUTER_ROOT = '/workspace';
// eslint-disable-next-line unicorn/no-null -- Existing filesystem RPC uses null for a missing entry.
const MISSING_ENTRY = null;

export function computerPath(path: string): string {
	const relative = path === '/project' || path === COMPUTER_ROOT ? '/' : path.replace(/^\/(?:project|workspace)\//, '/');
	const components: string[] = [];
	for (const component of relative.split('/')) {
		if (!component || component === '.') continue;
		if (component === '..') {
			if (components.length === 0) throw new Error('Path escapes the project workspace');
			components.pop();
			continue;
		}
		components.push(component);
	}
	return `${COMPUTER_ROOT}/${components.join('/')}`.replace(/\/$/, '');
}

export function projectPath(path: string): string {
	return path === COMPUTER_ROOT ? '/' : path.startsWith(`${COMPUTER_ROOT}/`) ? path.slice(COMPUTER_ROOT.length) : path;
}

export class ComputerWorkspace implements WorkspaceLike {
	constructor(readonly computer: Workspace) {}

	private info(path: string, stat: Awaited<ReturnType<Workspace['fs']['stat']>>): FileStat & { mode: number } {
		return {
			path,
			name: stat.name,
			type: stat.isSymbolicLink ? 'symlink' : stat.isDirectory ? 'directory' : 'file',
			mimeType: getContentType(path),
			mode: stat.mode,
			size: stat.size,
			createdAt: stat.mtime,
			updatedAt: stat.mtime,
		};
	}

	async readFile(path: string): Promise<string | null> {
		if (!(await this.exists(path))) return MISSING_ENTRY;
		return this.computer.fs.readFile(computerPath(path), 'utf8');
	}
	async readFileBytes(path: string): Promise<Uint8Array | null> {
		if (!(await this.exists(path))) return MISSING_ENTRY;
		return new Uint8Array(await new Response(await this.computer.fs.readFile(computerPath(path))).arrayBuffer());
	}
	async writeFile(path: string, content: string): Promise<void> {
		const target = computerPath(path);
		await this.computer.fs.mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true });
		await this.computer.fs.writeFile(target, content);
	}
	async writeFileBytes(path: string, content: Uint8Array): Promise<void> {
		const target = computerPath(path);
		await this.computer.fs.mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true });
		await this.computer.fs.writeFile(target, content);
	}
	async appendFile(path: string, content: string): Promise<void> {
		await this.writeFile(path, ((await this.readFile(path)) ?? '') + content);
	}
	async exists(path: string): Promise<boolean> {
		return Boolean(await this.stat(path));
	}
	async stat(path: string): Promise<(FileStat & { mode: number }) | null> {
		try {
			return this.info(projectPath(path), await this.computer.fs.stat(computerPath(path)));
		} catch (error) {
			if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return MISSING_ENTRY;
			throw error;
		}
	}
	async lstat(path: string): Promise<(FileStat & { mode: number }) | null> {
		try {
			return this.info(projectPath(path), await this.computer.fs.lstat(computerPath(path)));
		} catch (error) {
			if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return MISSING_ENTRY;
			throw error;
		}
	}
	async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		await this.computer.fs.mkdir(computerPath(path), options);
	}
	async readDir(path: string): Promise<FileInfo[]> {
		const entries = await this.computer.fs.readdir(computerPath(path));
		return entries.map((entry) => ({
			path: `${projectPath(path).replace(/\/$/, '')}/${entry.name}`,
			name: entry.name,
			type: entry.isSymbolicLink ? 'symlink' : entry.isDirectory ? 'directory' : 'file',
			mimeType: getContentType(entry.name),
			size: entry.size,
			createdAt: entry.mtime,
			updatedAt: entry.mtime,
		}));
	}
	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		await this.computer.fs.rm(computerPath(path), options);
	}
	async cp(source: string, destination: string, options?: { recursive?: boolean }): Promise<void> {
		const info = await this.lstat(source);
		if (!info) throw new Error(`ENOENT: ${source}`);
		if (info.type === 'symlink') {
			await this.symlink(await this.readlink(source), destination);
			return;
		}
		if (info.type === 'directory') {
			if (!options?.recursive) throw new Error(`EISDIR: ${source}`);
			await this.mkdir(destination, { recursive: true });
			for (const entry of await this.readDir(source)) await this.cp(entry.path, `${destination}/${entry.name}`, options);
			return;
		}
		const bytes = await this.readFileBytes(source);
		if (!bytes) throw new Error(`ENOENT: ${source}`);
		await this.writeFileBytes(destination, bytes);
		if ('mode' in info && typeof info.mode === 'number') await this.chmod(destination, info.mode);
	}
	async mv(source: string, destination: string): Promise<void> {
		await this.computer.fs.rename(computerPath(source), computerPath(destination));
	}
	async chmod(path: string, mode: number): Promise<void> {
		await this.computer.fs.chmod(computerPath(path), mode);
	}
	async symlink(target: string, path: string): Promise<void> {
		const link = computerPath(path);
		await this.computer.fs.mkdir(link.slice(0, link.lastIndexOf('/')), { recursive: true });
		await this.computer.fs.symlink(target.startsWith('/') ? computerPath(target) : target, computerPath(path));
	}
	async readlink(path: string): Promise<string> {
		const target = await this.computer.fs.readlink(computerPath(path));
		return target.startsWith('/') ? projectPath(target) : target;
	}
	async _getAllPaths(): Promise<string[]> {
		const paths: string[] = [];
		const visit = async (path: string): Promise<void> => {
			paths.push(path);
			for (const entry of await this.readDir(path)) {
				if (entry.type === 'directory') await visit(entry.path);
				else paths.push(entry.path);
			}
		};
		await visit('/');
		return paths;
	}
	async glob(pattern: string): Promise<FileInfo[]> {
		const paths = await this._getAllPaths();
		const entries: FileInfo[] = [];
		for (const path of paths) {
			if (!minimatch(path, pattern, { dot: true })) continue;
			const info = await this.lstat(path);
			if (info) entries.push(info);
		}
		return entries;
	}
	async getWorkspaceInfo() {
		let fileCount = 0;
		let directoryCount = 0;
		let totalBytes = 0;
		for (const path of await this._getAllPaths()) {
			const info = await this.lstat(path);
			if (info?.type === 'directory') directoryCount++;
			if (info?.type === 'file') {
				fileCount++;
				totalBytes += info.size;
			}
		}
		return { fileCount, directoryCount, totalBytes, r2FileCount: 0 };
	}
}
