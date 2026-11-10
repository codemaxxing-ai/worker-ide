import { WorkspaceFilesystemStub, WorkspaceGitStub, WorkspaceRuntimeStub, WorkspaceStub } from '@cloudflare/computer';

import { computerPath, projectPath } from './computer-workspace';

import type { ProjectFilesystem } from '../durable/project-filesystem';
import type { Workspace } from '@cloudflare/computer';

/** Every write enters the same project mutation boundary as editor and agent tools. */
class AgentFilesystem extends WorkspaceFilesystemStub {
	constructor(
		workspace: Workspace,
		private readonly host: ProjectFilesystem,
		private readonly sessionId: string,
	) {
		super(workspace);
	}
	readFile(path: string): Promise<ReadableStream<Uint8Array>>;
	readFile(path: string, encoding: 'utf8'): Promise<string>;
	readFile(path: string, options: Parameters<Workspace['fs']['readFile']>[1] & { encoding: 'utf8' }): Promise<string>;
	readFile(
		path: string,
		options: Parameters<Workspace['fs']['readFile']>[1] & { encoding?: undefined },
	): Promise<ReadableStream<Uint8Array>>;
	readFile(path: string, options: Parameters<Workspace['fs']['readFile']>[1]): Promise<string | ReadableStream<Uint8Array>>;
	readFile(path: string, options?: Parameters<Workspace['fs']['readFile']>[1] | 'utf8') {
		return options === 'utf8'
			? super.readFile(computerPath(path), 'utf8')
			: options
				? super.readFile(computerPath(path), options)
				: super.readFile(computerPath(path));
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
	lstat(path: string): ReturnType<WorkspaceFilesystemStub['lstat']> {
		return super.lstat(computerPath(path));
	}
	lstatOrNull(path: string): ReturnType<WorkspaceFilesystemStub['lstatOrNull']> {
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
	async writeFile(path: string, content: Parameters<WorkspaceFilesystemStub['writeFile']>[1]): Promise<void> {
		const bytes =
			typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(await new Response(content).arrayBuffer());
		await this.host.wsWriteFileBytes(projectPath(computerPath(path)), bytes, this.sessionId);
	}
	mkdir(path: string, options?: Parameters<WorkspaceFilesystemStub['mkdir']>[1]) {
		return this.host.wsMkdir(projectPath(computerPath(path)), options?.recursive ?? false, this.sessionId);
	}
	rm(path: string, options?: Parameters<WorkspaceFilesystemStub['rm']>[1]) {
		return this.host.wsRm(projectPath(computerPath(path)), options?.recursive ?? false, options?.force ?? false, this.sessionId);
	}
	rename(source: string, destination: string) {
		return this.host.wsMv(projectPath(computerPath(source)), projectPath(computerPath(destination)), this.sessionId);
	}
	chmod(path: string, mode: number) {
		return this.host.wsChmod(projectPath(computerPath(path)), mode, this.sessionId);
	}
	symlink(target: string, path: string) {
		return this.host.wsSymlink(target, projectPath(computerPath(path)), this.sessionId);
	}
}

/** Built-in helpers cannot bypass the managed execution or Git tools. */
class AgentRuntime extends WorkspaceRuntimeStub {
	backends() {
		return [];
	}
	async exec(): Promise<never> {
		throw new Error('Use the managed exec tool.');
	}
	async getExec(): Promise<never> {
		throw new Error('Use the managed execution receipt.');
	}
	async killExec(): Promise<never> {
		throw new Error('Use the managed cancellation API.');
	}
	async disposeExec(): Promise<never> {
		throw new Error('Use the managed execution receipt.');
	}
	async respond(): Promise<never> {
		throw new Error('Workspace execution responses are unavailable.');
	}
	async pending() {
		return [];
	}
}
class AgentGit extends WorkspaceGitStub {
	async cli(): Promise<never> {
		throw new Error('Use the project Git tools.');
	}
}

export class AgentWorkspace extends WorkspaceStub {
	private readonly filesystem: AgentFilesystem;
	private readonly execution: AgentRuntime;
	private readonly repository: AgentGit;
	constructor(workspace: Workspace, host: ProjectFilesystem, sessionId: string) {
		super(workspace);
		this.filesystem = new AgentFilesystem(workspace, host, sessionId);
		this.execution = new AgentRuntime(workspace);
		this.repository = new AgentGit(workspace);
	}
	get fs() {
		return this.filesystem;
	}
	get runtime() {
		return this.execution;
	}
	get git() {
		return this.repository;
	}
	get assets(): undefined {
		return;
	}
	get hasAssets() {
		return false;
	}
	get artifacts(): never {
		throw new Error('Use the project Git tools.');
	}
}
