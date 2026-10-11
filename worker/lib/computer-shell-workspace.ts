import { WorkspaceFilesystemStub, WorkspaceGitStub, WorkspaceStub } from '@cloudflare/computer';

import { computerPath } from './computer-workspace';

import type { Workspace } from '@cloudflare/computer';

type ReadOptions = Parameters<Workspace['fs']['readFile']>[1];

/** Shell paths use the same project mount as state helpers and editor RPC. */
class ProjectShellFilesystem extends WorkspaceFilesystemStub {
	constructor(
		workspace: Workspace,
		private readonly assertOwner: () => void,
	) {
		super(workspace);
	}
	readFile(path: string): Promise<ReadableStream<Uint8Array>>;
	readFile(path: string, encoding: 'utf8'): Promise<string>;
	readFile(path: string, options: ReadOptions & { encoding?: undefined }): Promise<ReadableStream<Uint8Array>>;
	readFile(path: string, options: ReadOptions & { encoding: 'utf8' }): Promise<string>;
	readFile(path: string, options: ReadOptions): Promise<string | ReadableStream<Uint8Array>>;
	readFile(path: string, options?: ReadOptions | 'utf8') {
		if (options === 'utf8') return super.readFile(computerPath(path), options);
		if (options) return super.readFile(computerPath(path), options);
		return super.readFile(computerPath(path));
	}
	exists(path: string) {
		return super.exists(computerPath(path));
	}
	stat(path: string): ReturnType<WorkspaceFilesystemStub['stat']> {
		return super.stat(computerPath(path));
	}
	statOrNull(path: string): ReturnType<WorkspaceFilesystemStub['statOrNull']> {
		return super.statOrNull(computerPath(path));
	}
	lstat(path: string): ReturnType<WorkspaceFilesystemStub['stat']> {
		return super.lstat(computerPath(path));
	}
	lstatOrNull(path: string): ReturnType<WorkspaceFilesystemStub['statOrNull']> {
		return super.lstatOrNull(computerPath(path));
	}
	readlink(path: string) {
		return super.readlink(computerPath(path));
	}
	readdir(path: string, options?: Parameters<WorkspaceFilesystemStub['readdir']>[1]): ReturnType<WorkspaceFilesystemStub['readdir']> {
		return super.readdir(computerPath(path), options);
	}
	find(
		path: string,
		pattern?: string,
		options?: Parameters<WorkspaceFilesystemStub['find']>[2],
	): ReturnType<WorkspaceFilesystemStub['find']> {
		return super.find(computerPath(path), pattern, options);
	}
	ls(path: string) {
		return super.ls(computerPath(path));
	}
	grep(
		pattern: string,
		path: string,
		options?: Parameters<WorkspaceFilesystemStub['grep']>[2],
	): ReturnType<WorkspaceFilesystemStub['grep']> {
		return super.grep(pattern, computerPath(path), options);
	}
	writeFile(
		path: string,
		content: Parameters<WorkspaceFilesystemStub['writeFile']>[1],
		options?: Parameters<WorkspaceFilesystemStub['writeFile']>[2],
	) {
		this.assertOwner();
		return super.writeFile(computerPath(path), content, options);
	}
	mkdir(path: string, options?: Parameters<WorkspaceFilesystemStub['mkdir']>[1]) {
		this.assertOwner();
		return super.mkdir(computerPath(path), options);
	}
	rm(path: string, options?: Parameters<WorkspaceFilesystemStub['rm']>[1]) {
		this.assertOwner();
		return super.rm(computerPath(path), options);
	}
	rename(source: string, destination: string) {
		this.assertOwner();
		return super.rename(computerPath(source), computerPath(destination));
	}
	chmod(path: string, mode: number) {
		this.assertOwner();
		return super.chmod(computerPath(path), mode);
	}
	symlink(target: string, path: string) {
		this.assertOwner();
		return super.symlink(target.startsWith('/') ? computerPath(target) : target, computerPath(path));
	}
}

class ProjectShellGit extends WorkspaceGitStub {
	constructor(
		workspace: Workspace,
		private readonly assertOwner: () => void,
	) {
		super(workspace);
	}
	cli(input: Parameters<WorkspaceGitStub['cli']>[0]): ReturnType<WorkspaceGitStub['cli']> {
		this.assertOwner();
		const argumentsValue = [...input.argv];
		const command = argumentsValue[0] === '-C' ? argumentsValue[2] : argumentsValue[0];
		if (['clone', 'fetch', 'pull', 'push', 'ls-remote'].includes(command ?? ''))
			throw new Error('Isolate shell networking is disabled. Use existing Git tools or the container gateway.');
		const cwd = computerPath(input.cwd ?? '/');
		const directory = argumentsValue[1];
		if (argumentsValue[0] === '-C' && directory)
			argumentsValue[1] = computerPath(directory.startsWith('/') ? directory : `${cwd}/${directory}`);
		return super.cli({ ...input, argv: argumentsValue, cwd });
	}
}

export class ComputerShellWorkspace extends WorkspaceStub {
	private readonly filesystem: ProjectShellFilesystem;
	private readonly localGit: ProjectShellGit;
	constructor(workspace: Workspace, assertOwner: () => void) {
		super(workspace);
		this.filesystem = new ProjectShellFilesystem(workspace, assertOwner);
		this.localGit = new ProjectShellGit(workspace, assertOwner);
	}
	get fs() {
		return this.filesystem;
	}
	get git() {
		return this.localGit;
	}
}
