import { Buffer } from 'node:buffer';

import { Workspace as Computer } from '@cloudflare/computer';
import { ContainerBackend, withWorkspaceContainer } from '@cloudflare/computer/backends/container';
import { WorkerShellBackend } from '@cloudflare/computer/backends/worker-shell';
import { createGitClient } from '@cloudflare/computer/git';
import jqCommands from '@cloudflare/computer/shell/jq';
import { createAITools } from '@cloudflare/computer/tools';
import { DurableObject, exports } from 'cloudflare:workers';
import { z } from 'zod';

import { PROTECTED_SYSTEM_FILES, SNAPSHOT_EXCLUDED_DIRECTORIES } from '@shared/constants';
import { classifyOrigin } from '@shared/domain';
import { toolInputSchemas } from '@shared/validation/tools';
import { WorkerBuildBudget, isWorkerResourceLimit } from '@shared/worker-resource-budget';

import { GitService } from './git-service';
import { selectComputerBackend } from '../lib/computer-backend';
import { ComputerChanges } from '../lib/computer-changes';
import { drainComputerOutput } from '../lib/computer-execution';
import { ComputerMutationQueue, ComputerSynchronizationPending } from '../lib/computer-mutation-queue';
import { ComputerOutputPublisher } from '../lib/computer-output-observer';
import { ComputerProtectedFiles } from '../lib/computer-protected-files';
import { resolveComputerReview } from '../lib/computer-review';
import { ComputerShellWorkspace } from '../lib/computer-shell-workspace';
import { restoreComputerSnapshots } from '../lib/computer-snapshots';
import { computerStorage } from '../lib/computer-storage';
import { ComputerWorkspace, computerPath, projectPath } from '../lib/computer-workspace';
import { getDomainConfiguration } from '../lib/domain-configuration';
import { coordinatorNamespace } from '../lib/durable-object-namespaces';
import { applyManagedConfiguration } from '../lib/managed-configuration';
import { nativeBuildSchema } from '../lib/native-build';
import { collectNativePreviewSource } from '../lib/native-preview-source';
import { waitForNativeRuntime } from '../lib/native-runtime-readiness';
import { runWithProjectFs } from '../lib/project-fs';
import { generateProjectId } from '../lib/project-id';
import { ProjectRuntimeState } from '../lib/project-runtime-state';
import {
	regenerateProtectedFiles,
	writeDependencies,
	writeProjectName,
	writeAssetSettings,
	writeBindingsConfig,
} from '../lib/protected-files';
import { hashSnapshot } from '../lib/snapshot-hash';
import { withSpan } from '../lib/tracing';
import { WorkspaceFsAdapter } from '../lib/workspace-fs-adapter';
import { guardProtectedFile } from '../services/agent/protected-file-guard';
import { readRuntimeOverride, selectBuildBackend } from '../services/vite-host/runtimes/runtime-selection';

import type { GitAuthor, GitStatusResponse } from './git-service';
import type { ComputerOutputObserver } from '../lib/computer-output-observer';
import type { ManagedConfigurationTool } from '../lib/managed-configuration';
import type { PreviewBootstrap, PreviewBootstrapInputs } from '../lib/preview-bootstrap';
import type { RequestOriginContext } from '../services/agent/request-origin-context';
import type { FileInfo, FileStat } from '@cloudflare/shell';
import type { ComputerExecOptions, ComputerExecResult, ComputerReviewOptions } from '@shared/computer';
import type { ProjectFilesystemRpc } from '@shared/project-filesystem-rpc';
import type { RuntimeDecision, RuntimePhase, RuntimeStatus, RuntimeSurface } from '@shared/runtime-status';
import type { AssetSettings, BindingsConfig, GitBranchInfo, GitCommitEntry, GitFileDiff, GitMergeResult } from '@shared/types';

interface SeedFile {
	path: string;
	content: string;
}

/**
 * A workspace change with the content before/after the writer's edits, ready to
 * render as a diff. `beforeContent`/`afterContent` are `undefined` for
 * create/delete (respectively) or when content could not be read (binary,
 * directory, …).
 */

/**
 * SQLite table backing per-writer (per agent session) change tracking. Concurrent
 * sessions share one Workspace, so changes are attributed to the writer that made
 * them. On first touch a row records the pre-edit `baseline` content of a path;
 * `drainWorkspaceChanges(writerId)` diffs each baseline against current content
 * for that writer only, then clears the writer's rows.
 *
 * Persisted (not in-memory) so per-session diffs survive a Durable Object
 * eviction mid-turn — the checkpoint is durable, matching accept/reject
 * semantics. `baseline` is NULL when the path did not exist (or was unreadable)
 * at first touch, i.e. a create.
 */
const COMPUTER_MUTATIONS = new Set([
	'wsWriteFile',
	'wsWriteFileBytes',
	'wsAppendFile',
	'wsMkdir',
	'wsRm',
	'wsCp',
	'wsMv',
	'wsSymlink',
	'wsChmod',
	'writeFileContent',
	'writeFiles',
	'importTree',
	'gitInitialCommit',
	'gitInit',
	'gitStage',
	'gitUnstage',
	'gitStageAll',
	'gitUnstageAll',
	'gitDiscard',
	'gitDiscardAll',
	'gitCommit',
	'gitCreateBranch',
	'gitDeleteBranch',
	'gitRenameBranch',
	'gitCheckout',
	'gitMerge',
	'gitCreateTag',
	'gitDeleteTag',
	'computerExec',
	'computerApplyTool',
	'destroyStorage',
	'restoreSnapshots',
	'resolveWorkspaceReview',
	'writeAgentDocument',
	'updateManagedConfiguration',
	'updateProjectConfiguration',
]);

/**
 * Project filesystem Durable Object.
 *
 * A single durable Computer SQLite workspace holds
 * both the working tree and a real `.git`. Git operations run here, locally,
 * against that Workspace via {@link GitService}; Cloudflare Artifacts remains
 * the remote. There is no in-memory filesystem.
 */
class ProjectFilesystemBase extends DurableObject<Env> {}

export class ProjectFilesystem extends withWorkspaceContainer(ProjectFilesystemBase) implements ProjectFilesystemRpc {
	private computerInstance?: Computer;
	private computerAdapter?: ComputerWorkspace;
	private containerInstance?: ContainerBackend;
	private queueInstance?: ComputerMutationQueue;
	private changesInstance?: ComputerChanges;
	private nativePreviewStarting?: Promise<void>;
	private nativePreviewConfiguration?: string;
	private nativePreviewMonitor?: Promise<void>;
	private get runtimeState(): ProjectRuntimeState {
		return new ProjectRuntimeState(this.ctx.storage.kv);
	}

	getBuildRuntimeDecision(files: Record<string, string>): RuntimeDecision {
		const override = readRuntimeOverride(files);
		if (override === 'worker' || override === 'container') return this.runtimeState.select(override, 'explicit-choice');
		if (selectBuildBackend(files) === 'container') return this.runtimeState.select('container', 'project-requirements');
		if (this.runtimeState.promoted) return this.runtimeState.select('container', 'resource-limit');
		try {
			const budget = new WorkerBuildBudget();
			for (const [filename, contents] of Object.entries(files)) if (/\.(?:[mc]?[jt]sx?|css)$/.test(filename)) budget.addSource(contents);
		} catch (error) {
			if (!isWorkerResourceLimit(error)) throw error;
			this.runtimeState.promote();
			return this.runtimeState.select('container', 'resource-limit');
		}
		return this.runtimeState.select('worker', 'simple-project');
	}

	async promoteBuildRuntime(surface: RuntimeSurface): Promise<RuntimeDecision> {
		this.runtimeState.promote();
		const decision = this.runtimeState.select('container', 'resource-limit');
		await this.reportRuntimeStatus(surface, decision, 'starting');
		return decision;
	}

	async reportRuntimeStatus(surface: RuntimeSurface, decision: RuntimeDecision, phase: RuntimePhase): Promise<void> {
		const status = this.runtimeState.update(surface, decision, phase);
		if (!status) return;
		await coordinatorNamespace
			.getByName(`project:${this.projectId}`)
			.updateRuntimeStatus(status)
			.catch((error: unknown) => {
				console.error('Runtime status broadcast failed', error);
			});
	}

	async getRuntimeStatus(): Promise<RuntimeStatus> {
		const status = this.runtimeState.status;
		if (status.preview.backend === 'container' && status.preview.phase === 'ready' && !this.ctx.container?.running) {
			await this.reportRuntimeStatus(
				'preview',
				{ backend: 'container', generation: status.preview.generation, reason: status.preview.reason ?? 'project-requirements' },
				'sleeping',
			);
		}
		return this.runtimeState.status;
	}

	private get projectId(): string {
		return generateProjectId(this.ctx.id);
	}

	private assertComputerStore(): void {
		const store = this.ctx.storage.kv.get<string>('project-active-store');
		if (store === 'computer') return;
		const hasStoredProject =
			store !== undefined ||
			this.ctx.storage.kv.get<boolean>('initialized') === true ||
			this.ctx.storage.kv.get('computer-migration-v1') !== undefined;
		const hasLegacyTable =
			this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cf_workspace_default'").toArray().length >
			0;
		const hasLegacyEntries = hasLegacyTable && this.ctx.storage.sql.exec('SELECT 1 FROM cf_workspace_default LIMIT 1').toArray().length > 0;
		if (!hasStoredProject && !hasLegacyEntries) return;
		throw new Error('Project workspace has no verified Computer store. Workspace recovery is required.');
	}

	private get computer(): Computer {
		this.assertComputerStore();
		if (this.computerInstance) return this.computerInstance;
		const reference = { binding: 'DurableObjectFilesystem', id: this.ctx.id.toString() };
		this.containerInstance = new ContainerBackend({
			id: 'container',
			name: 'computer',
			instance: 'standard-1',
			container: () => this,
			workspace: reference,
			egress: { mode: 'http-gateway', gateway: exports.ComputerEgress({ props: { projectObjectId: this.ctx.id.toString() } }) },
			ignore: ['**/node_modules', '**/.cache', '**/.bun', '**/.next', '**/dist', '**/coverage', '**/tmp'],
		});
		this.computerInstance = new Computer({
			storage: computerStorage(this.ctx.storage),
			git: createGitClient({ adapter: async () => new WorkspaceFsAdapter(this.workspace) }),
			backends: [
				new WorkerShellBackend({
					id: 'shell',
					loader: this.env.LOADER,
					ctx: this.ctx,
					workspace: reference,
					commands: [jqCommands],
					egress: { mode: 'none' },
				}),
				this.containerInstance,
			],
		});
		return this.computerInstance;
	}

	private get workspace(): ComputerWorkspace {
		this.assertComputerStore();
		return (this.computerAdapter ??= new ComputerWorkspace(this.computer));
	}

	private get queue(): ComputerMutationQueue {
		return (this.queueInstance ??= new ComputerMutationQueue(this.ctx.storage, async (operation, argumentsJson) => {
			const argumentsValue: unknown = JSON.parse(argumentsJson, (_key, value) => {
				const bytes = z.object({ computerBytes: z.union([z.array(z.number()), z.string()]) }).safeParse(value);
				return bytes.success
					? typeof bytes.data.computerBytes === 'string'
						? new Uint8Array(Buffer.from(bytes.data.computerBytes, 'base64'))
						: new Uint8Array(bytes.data.computerBytes)
					: value;
			});
			const parameters = z
				.array(z.unknown())
				.parse(argumentsValue)
				.map((parameter) => parameter ?? undefined);
			if (!COMPUTER_MUTATIONS.has(operation)) throw new Error(`Unknown queued mutation: ${operation}`);
			const method = Reflect.get(this, operation);
			if (typeof method !== 'function') throw new Error(`Missing queued mutation: ${operation}`);
			await Reflect.apply(method, this, parameters);
		}));
	}

	private async mutate<T>(operation: string, parameters: unknown[], execute: () => Promise<T>): Promise<T> {
		return this.queue.run(operation, parameters, async () => {
			await this.ensureComputer();
			try {
				const result = await execute();
				await this.changes.finish();
				await this.syncNativePreview();
				return result;
			} catch (error) {
				if (!(error instanceof ComputerSynchronizationPending)) await this.changes.finish();
				throw error;
			}
		});
	}

	private async syncNativePreview(): Promise<void> {
		if (!this.ctx.container?.running || this.ctx.storage.kv.get('computer-native-preview') !== true) return;
		try {
			await this.pushNativeSource();
		} catch (error) {
			this.nativePreviewConfiguration = undefined;
			this.ctx.storage.kv.delete('computer-native-preview');
			console.error('Native preview synchronization failed', error);
		}
	}
	private async pushNativeSource(): Promise<void> {
		for await (const _progress of this.computer.push('container')) {
			/* Preserve FIFO ownership through synchronization. */
		}
		await waitForNativeRuntime(() =>
			this.getWorkspaceContainer().fetchPort(8788, 'http://container/health', { signal: AbortSignal.timeout(3000) }),
		);
		const source = await collectNativePreviewSource(this.workspace);
		const response = await this.getWorkspaceContainer().fetchPort(8788, 'http://container/sync', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(source),
			signal: AbortSignal.timeout(10_000),
		});
		await response.body?.cancel();
		if (!response.ok) throw new Error('Native source synchronization failed');
	}

	private async nativePreviewFetch(request: Request, ideOrigin: string, contentOrigin: string): Promise<Response> {
		const selected = this.ctx.storage.kv.get<RuntimeDecision>('project-runtime-decision');
		const decision = selected?.backend === 'container' ? selected : undefined;
		if (decision) await this.reportRuntimeStatus('preview', decision, 'starting');
		try {
			const response = await this.serveNativePreview(request, ideOrigin, contentOrigin);
			if (decision) await this.reportRuntimeStatus('preview', decision, response.status < 500 ? 'ready' : 'error');
			return response;
		} catch (error) {
			if (decision) await this.reportRuntimeStatus('preview', decision, 'error');
			throw error;
		}
	}

	private async serveNativePreview(request: Request, ideOrigin: string, contentOrigin: string): Promise<Response> {
		this.assertComputerStore();
		const origin = new URL(request.url).origin;
		const inputs: Record<string, string> = { origin, ideOrigin };
		for (const filename of [
			'package.json',
			'bun.lock',
			'bun.lockb',
			'package-lock.json',
			'yarn.lock',
			'pnpm-lock.yaml',
			'vite.config.ts',
			'vite.config.js',
			'vite.config.mts',
			'vite.config.mjs',
			'vite.config.cts',
			'vite.config.cjs',
		]) {
			const content = await this.workspace.readFile(`/${filename}`);
			if (typeof content === 'string') inputs[filename] = content;
		}
		const configuration = await hashSnapshot(inputs);
		if (!this.ctx.container?.running) this.nativePreviewConfiguration = undefined;
		while (this.nativePreviewConfiguration !== configuration) {
			this.nativePreviewStarting ??= (async () => {
				await this.registerComputerSession('native-preview', 'code', { appOrigin: ideOrigin, contentOrigin });
				const recorded = this.ctx.storage.kv.get<{ id: string; configuration: string; origin: string; ideOrigin: string }>(
					'computer-native-start',
				);
				const previous = recorded
					? this.ctx.storage.kv.get<{ result?: ComputerExecResult }>(`computer-execution:${recorded.id}`)
					: undefined;
				const preparation =
					recorded && previous?.result?.syncStatus !== 'complete'
						? recorded
						: { id: crypto.randomUUID(), configuration, origin, ideOrigin };
				this.ctx.storage.kv.put('computer-native-start', preparation);
				const result = await this.computerExec(
					'node --experimental-import-meta-resolve /opt/worker-ide/native-runtime.ts prepare',
					{
						id: preparation.id,
						backend: 'container',
						nativeRuntime: true,
						env: { WORKER_IDE_PREVIEW_ORIGIN: preparation.origin, WORKER_IDE_APP_ORIGIN: preparation.ideOrigin },
					},
					'native-preview',
				);
				if (result.exitCode !== 0 || result.syncStatus !== 'complete')
					throw new Error(result.stderr || 'Native Vite preview could not start');
				this.nativePreviewConfiguration = preparation.configuration;
				this.ctx.storage.kv.put('computer-native-preview', true);
			})().finally(() => {
				this.nativePreviewStarting = undefined;
			});
			await this.nativePreviewStarting;
		}
		await this.getWorkspaceContainer().setInactivityTimeout(120_000);
		const url = new URL(request.url);
		url.protocol = 'http:';
		const forwarded = new Request(url, request);
		if (import.meta.env.DEV) {
			const protocol = forwarded.headers.get('Sec-WebSocket-Protocol');
			if (protocol?.startsWith('worker-ide-vite')) forwarded.headers.set('Sec-WebSocket-Protocol', protocol.slice('worker-ide-'.length));
		}
		try {
			const response = await this.getWorkspaceContainer().fetchPort(5173, forwarded);
			if (!this.nativePreviewMonitor && this.ctx.container) {
				this.nativePreviewMonitor = this.ctx.container
					.monitor()
					.catch(() => {})
					.then(async () => {
						this.nativePreviewMonitor = undefined;
						if (this.ctx.container?.running) return;
						this.nativePreviewConfiguration = undefined;
						await this.getRuntimeStatus();
					});
				this.ctx.waitUntil(this.nativePreviewMonitor);
			}
			return response;
		} catch (error) {
			this.nativePreviewConfiguration = undefined;
			throw error;
		}
	}

	async nativeBuild(snapshotHash: string): Promise<z.infer<typeof nativeBuildSchema>> {
		this.assertComputerStore();
		await this.registerComputerSession('native-build', 'code', { appOrigin: this.env.APP_ORIGIN, contentOrigin: this.env.CONTENT_ORIGIN });
		const recorded = this.ctx.storage.kv.get<{ id: string; snapshotHash: string }>('computer-native-build');
		const previous = recorded ? this.ctx.storage.kv.get<{ result?: ComputerExecResult }>(`computer-execution:${recorded.id}`) : undefined;
		if (recorded && previous && recorded.snapshotHash !== snapshotHash && previous.result?.syncStatus !== 'complete')
			throw new Error('A previous native build is still being recovered. Wait for synchronization before building another snapshot.');
		const identifier =
			recorded?.snapshotHash === snapshotHash && previous?.result?.syncStatus !== 'complete' ? recorded.id : crypto.randomUUID();
		this.ctx.storage.kv.put('computer-native-build', { id: identifier, snapshotHash });
		const result = await this.computerExec(
			'node --experimental-import-meta-resolve /opt/worker-ide/native-runtime.ts build',
			{
				id: identifier,
				backend: 'container',
				nativeRuntime: true,
				expectedSnapshotHash: snapshotHash,
				env: { WORKER_IDE_BUILD_ID: identifier },
			},
			'native-build',
		);
		if (result.exitCode !== 0 || result.syncStatus !== 'complete') throw new Error(result.stderr || 'Native Vite build failed');
		const response = await this.getWorkspaceContainer().fetchPort(8788, `http://container/artifact?id=${identifier}`);
		if (!response.ok) throw new Error('Native build artifact is unavailable');
		return nativeBuildSchema.parse(await response.json());
	}

	private async ensureComputer(): Promise<void> {
		if (this.ctx.storage.kv.get<string>('project-active-store') === 'computer') return;
		await this.workspace.mkdir('/', { recursive: true });
		this.ctx.storage.kv.put('project-active-store', 'computer');
	}
	async alarm(): Promise<void> {
		await this.queue.resume();
	}
	async __getWorkspaceStub() {
		void this.queue;
		const owner = this.ctx.storage.sql
			.exec<{ sequence: number; operation: string }>(
				"SELECT sequence, operation FROM computer_mutation_queue WHERE status IN ('running', 'sync-pending') ORDER BY sequence LIMIT 1",
			)
			.toArray()[0];
		const assertOwner = () => {
			const current = this.ctx.storage.sql
				.exec<{ sequence: number; operation: string }>(
					"SELECT sequence, operation FROM computer_mutation_queue WHERE status IN ('running', 'sync-pending') ORDER BY sequence LIMIT 1",
				)
				.toArray()[0];
			if (!owner || owner.operation !== 'computerExec' || current?.sequence !== owner.sequence)
				throw new Error('Runtime writes require the original execution ownership');
		};
		return new ComputerShellWorkspace(this.computer, assertOwner, async (path, descendants, followFinalLink) => {
			assertOwner();
			await this.assertAgentPath('shell', path, descendants, followFinalLink);
			assertOwner();
		});
	}

	getComputerRequestOrigin() {
		return this.ctx.storage.kv.get<RequestOriginContext>('computer-request-origin');
	}
	async fetch(request: Request): Promise<Response> {
		const configuration = getDomainConfiguration(this.env);
		if (classifyOrigin(new URL(request.url).origin, configuration).type === 'preview')
			return this.nativePreviewFetch(request, configuration.appOrigin, configuration.contentOrigin);
		void this.computer;
		if (!this.containerInstance) throw new Error('Container backend is unavailable');
		return this.containerInstance.handleFetch(request);
	}

	async registerComputerSession(sessionId: string, mode: 'code' | 'plan' | 'ask', origin?: RequestOriginContext): Promise<void> {
		this.ctx.storage.kv.put(`computer-session:${sessionId}`, mode);

		if (origin) this.ctx.storage.kv.put('computer-request-origin', origin);
	}

	async beginComputerSessionTurn(
		sessionId: string,
		submissionId: string,
		mode: 'code' | 'plan' | 'ask',
		origin?: RequestOriginContext,
	): Promise<void> {
		await this.registerComputerSession(sessionId, mode, origin);
		const key = `computer-session-turn:${sessionId}`;
		if (this.ctx.storage.kv.get(key) === submissionId) return;
		this.ctx.storage.kv.put(key, submissionId);
		this.ctx.storage.kv.delete(`computer-session-cancelled:${sessionId}`);
	}

	/** Trusted plan/todo tools get a constrained path, even in read-only modes. */
	async writeAgentDocument(
		kind: 'plan' | 'todos',
		sessionId: string,
		content: string,
	): Promise<{ path: string; previousContent?: string }> {
		if (!/^[\w:-]+$/.test(sessionId)) throw new Error('Invalid agent document session');
		if (kind !== 'plan' && kind !== 'todos') throw new Error('Invalid agent document kind');
		const path = kind === 'plan' ? `/.agent/plans/${sessionId}.md` : `/.agent/todo/${sessionId}.json`;
		return this.mutate('writeAgentDocument', [kind, sessionId, content], async () => {
			const previousContent = (await this.workspace.readFile(path)) ?? undefined;
			await this.workspace.writeFile(path, content);
			return { path, previousContent };
		});
	}

	private assertWritable(writerId?: string): void {
		if (!writerId) return;
		const mode = this.ctx.storage.kv.get<string>(`computer-session:${writerId}`);
		if (mode === 'plan' || mode === 'ask') throw new Error(`${mode} mode cannot mutate the project workspace`);
	}

	private async assertAgentPath(writerId: string | undefined, path: string, descendants = false, followFinalLink = true): Promise<void> {
		if (writerId === undefined) return;
		const normalized = projectPath(computerPath(path));
		const resolved = await this.changes.resolveWritePath(normalized, followFinalLink);
		for (const protectedPath of PROTECTED_SYSTEM_FILES) {
			const protectedTarget = await this.changes.resolveWritePath(protectedPath);
			if (
				[normalized, resolved].some((target) =>
					[protectedPath, protectedTarget].some(
						(protectedEntry) =>
							target === protectedEntry || (descendants && protectedEntry.startsWith(target === '/' ? '/' : `${target}/`)),
					),
				)
			) {
				guardProtectedFile(protectedPath);
			}
		}
	}

	/** Keep each configuration read/merge/regeneration under one durable owner. */
	async updateManagedConfiguration(
		toolName: ManagedConfigurationTool,
		input: Record<string, string>,
		writerId?: string,
	): Promise<{ title: string; output: string; metadataJson: string }> {
		this.assertWritable(writerId);
		return this.mutate('updateManagedConfiguration', [toolName, input, writerId], async () => {
			this.assertWritable(writerId);
			if (writerId)
				for (const path of PROTECTED_SYSTEM_FILES) {
					await this.captureBaseline(writerId, path);
					await this.captureBaseline(writerId, await this.changes.resolveWritePath(path));
				}
			return runWithProjectFs(new WorkspaceFsAdapter(this.workspace, '/project'), async () => {
				const result = await applyManagedConfiguration(toolName, input, '/project');
				return { title: result.title, output: result.output, metadataJson: JSON.stringify(result.metadata) };
			});
		});
	}

	/** Trusted editor settings use the same queue as agent configuration tools. */
	async updateProjectConfiguration(settings: {
		name?: string;
		dependencies?: Record<string, string>;
		assetSettings?: AssetSettings;
		bindingsConfig?: BindingsConfig;
	}): Promise<void> {
		await this.mutate('updateProjectConfiguration', [settings], () =>
			runWithProjectFs(new WorkspaceFsAdapter(this.workspace, '/project'), async () => {
				if (settings.name) await writeProjectName('/project', settings.name);
				if (settings.dependencies !== undefined) await writeDependencies('/project', settings.dependencies);
				if (settings.assetSettings !== undefined) await writeAssetSettings('/project', settings.assetSettings);
				if (settings.bindingsConfig !== undefined) await writeBindingsConfig('/project', settings.bindingsConfig);
				await regenerateProtectedFiles('/project');
			}),
		);
	}

	async computerExec(
		command: string,
		options: ComputerExecOptions,
		sessionId: string,
		observer?: ComputerOutputObserver,
	): Promise<ComputerExecResult> {
		this.assertWritable(sessionId);
		const publisher = new ComputerOutputPublisher(observer, (promise) => this.ctx.waitUntil(promise));
		const identifier = options.id ?? crypto.randomUUID();
		const requestedBackend = options.backend;
		if (requestedBackend !== undefined && !['auto', 'shell', 'container'].includes(requestedBackend))
			throw new Error(`Unsupported execution backend: ${requestedBackend}`);
		return this.mutate('computerExec', [command, { ...options, id: identifier }, sessionId], async () => {
			this.assertWritable(sessionId);
			const key = `computer-execution:${identifier}`;
			const previous = this.ctx.storage.kv.get<{ status: string; sessionId: string; backend?: string; result?: ComputerExecResult }>(key);
			if (previous && previous.sessionId !== sessionId) throw new Error('Execution belongs to another session');
			if (previous?.result?.syncStatus === 'complete') return previous.result;
			const backend = selectComputerBackend(command, previous?.backend ?? requestedBackend);
			if (
				!previous &&
				options.expectedSnapshotHash !== undefined &&
				(await hashSnapshot(await this.buildSnapshotRecord(SNAPSHOT_EXCLUDED_DIRECTORIES))) !== options.expectedSnapshotHash
			)
				throw new Error('Project changed before native build started. Build again.');
			if (
				this.ctx.storage.kv.get(`computer-cancelled:${identifier}`) ||
				this.ctx.storage.kv.get(`computer-session-cancelled:${sessionId}`)
			) {
				if (!previous)
					return { id: identifier, backend, status: 'cancelled', exitCode: 137, stdout: '', stderr: '', syncStatus: 'complete' };
				await this.computer.runtime.killExec(identifier, { backend, signal: 'SIGKILL' });
			}
			// Validate and prepare before recording a possibly dispatched command.
			// Known preparation failures must not become an uncertain execution.
			const cwd = previous ? undefined : computerPath(options.cwd ?? '/');
			const input = previous || options.inputJson === undefined ? undefined : z.json().parse(JSON.parse(options.inputJson));
			if (!previous && backend === 'container') {
				for await (const _progress of this.computer.push('container')) {
					/* Start and synchronize before touching the running container. */
				}
				await this.getWorkspaceContainer().setInactivityTimeout(120_000);
			}
			if (!previous && options.nativeRuntime) await this.pushNativeSource();
			const protectedFiles = new ComputerProtectedFiles(this.ctx.storage, this.workspace);
			if (!previous) await protectedFiles.capture(identifier);
			this.changes.resume(sessionId);
			if (!previous) {
				for (const path of await this.workspace._getAllPaths()) await this.captureBaseline(sessionId, path);
				this.ctx.storage.kv.put(key, { status: 'starting', sessionId, backend });
			}
			try {
				let response = previous?.result;
				if (!response) {
					using handle = previous
						? await this.computer.runtime.getExec(identifier, { backend, encoding: 'utf8', resume: 'full' })
						: await this.computer.runtime.exec(command, {
								...options,
								input,
								id: identifier,
								backend,
								cwd,
								encoding: 'utf8',
								timeoutMs: backend === 'container' ? 300_000 : 30_000,
								sync: 'wait',
							});
					if (backend === 'container') await this.getWorkspaceContainer().setInactivityTimeout(120_000);
					this.ctx.storage.kv.put(key, { status: 'running', sessionId, backend });
					const output = await drainComputerOutput(
						handle,
						() => this.ctx.storage.setAlarm(Date.now() + 30_000),
						(output) => publisher.publish({ executionId: identifier, ...output }),
					);
					publisher.flush();
					const cancelled =
						Boolean(this.ctx.storage.kv.get(`computer-cancelled:${identifier}`)) || [130, 137, 143].includes(output.exitCode);
					response = {
						id: identifier,
						backend,
						status: cancelled ? 'cancelled' : output.exitCode === 0 ? 'completed' : 'failed',
						...output,
						syncStatus: 'pending',
					};
					this.ctx.storage.kv.put(key, { status: 'synchronization-pending', sessionId, backend, result: response });
				}
				if (backend === 'container') {
					for await (const progress of this.computer.pull(backend)) {
						await this.ctx.storage.setAlarm(Date.now() + 30_000);
						if (!progress.complete) continue;
					}
					await this.getWorkspaceContainer().setInactivityTimeout(120_000);
				}
				const restoredPaths = await protectedFiles.restore(identifier);
				if (restoredPaths.length > 0) {
					response = {
						...response,
						status: 'failed',
						exitCode: 1,
						stderr: `${response.stderr}\n[NOT_ALLOWED] Restored IDE-managed files: ${restoredPaths.join(', ')}. Use the dedicated configuration tools.`,
					};
				}
				for (const path of await this.workspace._getAllPaths()) this.markTouched(sessionId, path);
				await this.changes.finish();
				response = { ...response, syncStatus: 'complete' };
				this.ctx.storage.kv.put(key, { status: response.status, sessionId, backend, result: response });
				protectedFiles.clear(identifier);
				publisher.publish({
					executionId: identifier,
					stdout: response.stdout,
					stderr: response.stderr,
					stdoutBytes: new TextEncoder().encode(response.stdout).length,
					stderrBytes: new TextEncoder().encode(response.stderr).length,
					truncated: false,
					final: true,
				});
				publisher.flush();
				return response;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.ctx.storage.kv.put(key, {
					status: 'synchronization-pending',
					sessionId,
					backend,
					result: this.ctx.storage.kv.get<{ result?: ComputerExecResult }>(key)?.result,
					error: message,
				});
				throw new ComputerSynchronizationPending(
					`Execution ${identifier} cannot be released until synchronization succeeds: ${message}. The command will not be replayed.`,
					{ cause: error },
				);
			}
		});
	}

	async cancelComputerExecution(identifier: string, sessionId: string): Promise<void> {
		const record = this.ctx.storage.kv.get<{ sessionId: string; backend: string }>(`computer-execution:${identifier}`);
		if (record && record.sessionId !== sessionId) throw new Error('Execution does not belong to this session');
		this.ctx.storage.kv.put(`computer-cancelled:${identifier}`, true);
		if (!record) return;
		await this.computer.runtime.killExec(identifier, { backend: record.backend, signal: 'SIGKILL' });
	}

	async cancelComputerSessionExecutions(sessionId: string, submissionId?: string): Promise<void> {
		// A delayed cancellation RPC must not stop a newer turn in the same session.
		if (submissionId && this.ctx.storage.kv.get(`computer-session-turn:${sessionId}`) !== submissionId) return;
		this.ctx.storage.kv.put(`computer-session-cancelled:${sessionId}`, true);
		for (const [key, record] of this.ctx.storage.kv.list<{ sessionId: string; backend: string; status: string }>({
			prefix: 'computer-execution:',
		})) {
			if (record.sessionId !== sessionId || !['starting', 'running', 'synchronization-pending'].includes(record.status)) continue;
			await this.cancelComputerExecution(key.slice('computer-execution:'.length), sessionId);
		}
	}

	getComputerExecutions(sessionId: string) {
		return [
			...this.ctx.storage.kv.list<{ sessionId: string; backend: string; status: string; error?: string; result?: ComputerExecResult }>({
				prefix: 'computer-execution:',
			}),
		]
			.filter(([, record]) => record.sessionId === sessionId)
			.map(([key, record]) => ({ id: key.slice('computer-execution:'.length), ...record }));
	}

	async computerReadFile(path: string, options?: { byteOffset?: number; byteLength?: number }): Promise<ReadableStream<Uint8Array>> {
		return this.computer.fs.readFile(computerPath(path), options ?? {});
	}

	async computerFind(
		directory: string,
		pattern?: string,
		options?: { limit?: number; offset?: number },
	): Promise<Array<{ path: string; type: 'file' | 'dir' }>> {
		return this.computer.fs.find(computerPath(directory), pattern, options);
	}

	async computerGrep(
		pattern: string,
		path: string,
		options?: {
			regex?: boolean;
			ignoreCase?: boolean;
			context?: number;
			limit?: number;
			offset?: number;
			include?: string;
			exclude?: string[];
		},
	): ReturnType<Computer['fs']['grep']> {
		return this.computer.fs.grep(pattern, computerPath(path), options);
	}

	async computerApplyTool(name: 'write' | 'edit' | 'delete', input: unknown, sessionId: string): Promise<unknown> {
		this.assertWritable(sessionId);
		return this.mutate('computerApplyTool', [name, input, sessionId], async () => {
			this.assertWritable(sessionId);
			const parameters = toolInputSchemas[name].parse(input);
			await this.assertAgentPath(sessionId, parameters.path, name === 'delete', name !== 'delete');
			for (const path of await this.workspace._getAllPaths()) await this.captureBaseline(sessionId, path);
			const definition = createAITools({ workspace: this.computer, assets: false })[name];
			if (!definition.execute) throw new Error(`Computer tool ${name} is unavailable`);
			const result: unknown = await definition.execute(
				{ ...parameters, path: computerPath(parameters.path) },
				{ toolCallId: crypto.randomUUID(), messages: [], context: undefined },
			);
			for (const path of await this.workspace._getAllPaths()) this.markTouched(sessionId, path);
			return result;
		});
	}

	private get changes(): ComputerChanges {
		return (this.changesInstance ??= new ComputerChanges(this.ctx.storage, () => this.workspace));
	}

	private async captureBaseline(writerId: string, path: string): Promise<void> {
		let target = projectPath(computerPath(path));
		await this.changes.capture(writerId, target);
		while (target.includes('/') && target !== '/') {
			target = target.slice(0, target.lastIndexOf('/')) || '/';
			await this.changes.capture(writerId, target);
		}
	}

	private async captureTree(writerId: string, path: string): Promise<void> {
		await this.captureBaseline(writerId, path);
		const entry = await this.workspace.lstat(path);
		if (entry?.type !== 'directory') return;
		for (const child of await this.workspace.readDir(path)) await this.captureTree(writerId, child.path);
	}

	private async touchTree(writerId: string, path: string): Promise<void> {
		this.markTouched(writerId, path);
		const entry = await this.workspace.lstat(path);
		if (entry?.type !== 'directory') return;
		for (const child of await this.workspace.readDir(path)) await this.touchTree(writerId, child.path);
	}

	private markTouched(writerId: string, path: string): void {
		let target = projectPath(computerPath(path));
		this.changes.touch(writerId, target);
		while (target !== '/') {
			target = target.slice(0, target.lastIndexOf('/')) || '/';
			this.changes.touch(writerId, target);
		}
	}

	async drainWorkspaceChanges(writerId?: string) {
		if (writerId === undefined) return [];
		return this.changes.drain(writerId);
	}

	private git(): GitService {
		// isomorphic-git's lock is isolate-global and keyed by dir. Give each DO a
		// unique virtual root while the adapter maps it back to this Workspace's `/`.
		return new GitService(new WorkspaceFsAdapter(this.workspace, `/${this.projectId}`), this.env, this.projectId);
	}

	// =========================================================================
	// Workspace file RPC surface (forwarded to by the worker-side WorkspaceClient)
	// =========================================================================
	async wsReadFile(path: string): Promise<string | null> {
		return this.workspace.readFile(path);
	}
	async wsReadFileBytes(path: string): Promise<Uint8Array | null> {
		return this.workspace.readFileBytes(path);
	}
	async wsWriteFile(path: string, content: string, writerId?: string): Promise<void> {
		this.assertWritable(writerId);
		return this.mutate<Awaited<ReturnType<ProjectFilesystem['wsWriteFile']>>>('wsWriteFile', [path, content, writerId], async () => {
			await this.assertAgentPath(writerId, path);
			this.assertWritable(writerId);
			const target = await this.changes.resolveWritePath(path);
			if (writerId !== undefined) await this.captureBaseline(writerId, target);
			await this.workspace.writeFile(target, content);
			if (writerId !== undefined) this.markTouched(writerId, target);
		});
	}
	async wsWriteFileBytes(path: string, data: Uint8Array, writerId?: string): Promise<void> {
		this.assertWritable(writerId);
		return this.mutate<Awaited<ReturnType<ProjectFilesystem['wsWriteFileBytes']>>>('wsWriteFileBytes', [path, data, writerId], async () => {
			await this.assertAgentPath(writerId, path);
			this.assertWritable(writerId);
			const target = await this.changes.resolveWritePath(path);
			if (writerId !== undefined) await this.captureBaseline(writerId, target);
			await this.workspace.writeFileBytes(target, data);
			if (writerId !== undefined) this.markTouched(writerId, target);
		});
	}
	async wsAppendFile(path: string, content: string, writerId?: string): Promise<void> {
		this.assertWritable(writerId);
		return this.mutate<Awaited<ReturnType<ProjectFilesystem['wsAppendFile']>>>('wsAppendFile', [path, content, writerId], async () => {
			await this.assertAgentPath(writerId, path);
			this.assertWritable(writerId);
			const target = await this.changes.resolveWritePath(path);
			if (writerId !== undefined) await this.captureBaseline(writerId, target);
			await this.workspace.appendFile(target, content);
			if (writerId !== undefined) this.markTouched(writerId, target);
		});
	}
	async wsExists(path: string): Promise<boolean> {
		return this.workspace.exists(path);
	}
	async wsStat(path: string): Promise<(FileStat & { mode?: number }) | null> {
		return this.workspace.stat(path);
	}
	async wsLstat(path: string): Promise<(FileStat & { mode?: number }) | null> {
		return this.workspace.lstat(path);
	}
	async wsMkdir(path: string, recursive: boolean, writerId?: string): Promise<void> {
		this.assertWritable(writerId);
		return this.mutate<Awaited<ReturnType<ProjectFilesystem['wsMkdir']>>>('wsMkdir', [path, recursive, writerId], async () => {
			await this.assertAgentPath(writerId, path);
			this.assertWritable(writerId);
			if (writerId !== undefined) await this.captureBaseline(writerId, path);
			await this.workspace.mkdir(path, { recursive });
			if (writerId !== undefined) this.markTouched(writerId, path);
		});
	}
	async wsReadDir(path: string): Promise<FileInfo[]> {
		return this.workspace.readDir(path);
	}
	async wsRm(path: string, recursive: boolean, force: boolean, writerId?: string): Promise<void> {
		this.assertWritable(writerId);
		return this.mutate<Awaited<ReturnType<ProjectFilesystem['wsRm']>>>('wsRm', [path, recursive, force, writerId], async () => {
			await this.assertAgentPath(writerId, path, true, false);
			this.assertWritable(writerId);
			if (writerId !== undefined) await this.captureTree(writerId, path);
			await this.workspace.rm(path, { recursive, force });
			if (writerId !== undefined) this.markTouched(writerId, path);
		});
	}
	async wsCp(source: string, destination: string, recursive: boolean, writerId?: string): Promise<void> {
		this.assertWritable(writerId);
		return this.mutate<Awaited<ReturnType<ProjectFilesystem['wsCp']>>>('wsCp', [source, destination, recursive, writerId], async () => {
			await this.assertAgentPath(writerId, destination, recursive);
			this.assertWritable(writerId);
			if (writerId !== undefined) await this.captureTree(writerId, destination);
			await this.workspace.cp(source, destination, { recursive });
			if (writerId !== undefined) await this.touchTree(writerId, destination);
		});
	}
	async wsMv(source: string, destination: string, writerId?: string): Promise<void> {
		this.assertWritable(writerId);
		return this.mutate<Awaited<ReturnType<ProjectFilesystem['wsMv']>>>('wsMv', [source, destination, writerId], async () => {
			await this.assertAgentPath(writerId, source, true, false);
			await this.assertAgentPath(writerId, destination, true, false);
			this.assertWritable(writerId);
			if (writerId !== undefined) {
				await this.captureTree(writerId, source);
				await this.captureTree(writerId, destination);
			}
			await this.workspace.mv(source, destination);
			if (writerId !== undefined) {
				await this.touchTree(writerId, source);
				await this.touchTree(writerId, destination);
			}
		});
	}
	async wsSymlink(target: string, linkPath: string, writerId?: string): Promise<void> {
		this.assertWritable(writerId);
		return this.mutate<Awaited<ReturnType<ProjectFilesystem['wsSymlink']>>>('wsSymlink', [target, linkPath, writerId], async () => {
			await this.assertAgentPath(writerId, linkPath, false, false);
			this.assertWritable(writerId);
			if (writerId) await this.captureBaseline(writerId, linkPath);
			await this.workspace.symlink(target, linkPath);
			if (writerId) this.markTouched(writerId, linkPath);
		});
	}
	async wsChmod(path: string, mode: number, writerId?: string): Promise<void> {
		this.assertWritable(writerId);
		await this.mutate('wsChmod', [path, mode, writerId], async () => {
			await this.assertAgentPath(writerId, path);
			this.assertWritable(writerId);
			await this.workspace.chmod(path, mode);
		});
	}

	async wsReadlink(path: string): Promise<string> {
		return this.workspace.readlink(path);
	}
	async wsGlob(pattern: string): Promise<FileInfo[]> {
		return this.workspace.glob(pattern);
	}

	// =========================================================================
	// Project lifecycle
	// =========================================================================
	async projectExists(): Promise<boolean> {
		this.assertComputerStore();
		if (this.ctx.storage.kv.get<boolean>('initialized')) return true;
		const info = await this.workspace.getWorkspaceInfo().catch(() => {});
		return Boolean(info && info.fileCount > 0);
	}

	/**
	 * Prime a preview request in a single round trip.
	 *
	 * Reads existence + `wrangler.jsonc` + the runtime detection probe LOCALLY
	 * (SQLite reads are ~0ms in the DO) and returns the whole snapshot at once,
	 * so the worker pays one cross-DO latency instead of ~7 sequential ones.
	 * See {@link PreviewBootstrapInputs} for the contract; the worker interprets
	 * the raw snapshot via `buildDetectionProbe`.
	 */
	async collectPreviewBootstrap(inputs: PreviewBootstrapInputs): Promise<PreviewBootstrap> {
		const snapshot = await this.buildSnapshotRecord(inputs.excludedDirectories);
		const [exists, wranglerJsonc, packageJson, indexHtml, snapshotHash, configurationEntries, ...directoryEntries] = await Promise.all([
			this.projectExists(),
			this.workspace.readFile(inputs.wranglerPath).then((value) => value ?? undefined),
			this.workspace.readFile(inputs.packageJsonPath).then((value) => value ?? undefined),
			this.workspace.readFile(inputs.indexHtmlPath).then((value) => value ?? undefined),
			hashSnapshot(snapshot),
			Promise.all(
				(inputs.configurationPaths ?? []).map(async (path) => ({ path: `/${path}`, content: await this.workspace.readFile(`/${path}`) })),
			),
			...inputs.routerDirectories.map((directory) => this.workspace.readDir(`/${directory}`).catch(() => [])),
		]);
		const routerFirstEntries: Record<string, string | undefined> = {};
		for (const [index, directory] of inputs.routerDirectories.entries()) {
			routerFirstEntries[directory] = directoryEntries[index][0]?.name;
		}
		const configurationFiles: Record<string, string> = {};
		for (const entry of configurationEntries) if (typeof entry.content === 'string') configurationFiles[entry.path] = entry.content;
		return {
			exists,
			wranglerJsonc,
			packageJson,
			indexHtml,
			routerFirstEntries,
			snapshotHash,
			configurationFiles,
			runtimeDecision: this.getBuildRuntimeDecision(snapshot),
		};
	}

	/**
	 * Collect the project's text file tree in a single round trip.
	 *
	 * Walks the Workspace LOCALLY (SQLite reads are ~0ms in the DO) and returns
	 * every file keyed by its root-relative path, skipping any path whose segments
	 * include an excluded directory (`node_modules`, `dist`, `.git`, …). This
	 * replaces the preview worker walking the tree with one cross-DO readdir +
	 * readFile per node — hundreds of ms of serial RPC latency on every request.
	 */
	async collectProjectSnapshot(excludedDirectories: readonly string[]): Promise<Record<string, string>> {
		return withSpan('fs.collectProjectSnapshot', () => this.buildSnapshotRecord(excludedDirectories));
	}

	/**
	 * The snapshot's build-cache hash WITHOUT transferring the tree.
	 *
	 * Computed locally (SQLite reads are ~0ms in the DO) so the preview worker can
	 * probe its warm build cache cheaply: on a hit it skips fetching the whole
	 * tree entirely, and only calls {@link collectProjectSnapshot} on a miss. The
	 * hash is identical to `hashSnapshot(collectProjectSnapshot(...))`.
	 */
	async snapshotHash(excludedDirectories: readonly string[]): Promise<string> {
		return withSpan('fs.snapshotHash', async () => hashSnapshot(await this.buildSnapshotRecord(excludedDirectories)));
	}

	private async buildSnapshotRecord(excludedDirectories: readonly string[]): Promise<Record<string, string>> {
		const excluded = new Set(excludedDirectories);
		const paths = await this.workspace._getAllPaths();
		const files: Record<string, string> = {};
		await Promise.all(
			paths.map(async (path) => {
				if (path.split('/').some((segment) => excluded.has(segment))) {
					return;
				}
				const info = await this.workspace.stat(path);
				if (!info || info.type !== 'file') {
					return;
				}
				const content = (await this.workspace.readFile(path)) ?? undefined;
				if (content !== undefined) {
					files[path] = content;
				}
			}),
		);
		return files;
	}

	async writeFileContent(path: string, content: string): Promise<void> {
		return this.mutate<Awaited<ReturnType<ProjectFilesystem['writeFileContent']>>>('writeFileContent', [path, content], async () => {
			await this.workspace.writeFile(path, content);
			this.ctx.storage.kv.put('initialized', true);
		});
	}

	async writeFiles(files: ReadonlyArray<SeedFile>): Promise<void> {
		return this.mutate<Awaited<ReturnType<ProjectFilesystem['writeFiles']>>>('writeFiles', [files], async () => {
			for (const file of files) {
				await this.workspace.writeFile(file.path, file.content);
			}
			this.ctx.storage.kv.put('initialized', true);
		});
	}

	async destroyStorage(): Promise<void> {
		await this.queue.run('destroyStorage', [], async () => {
			if (this.ctx.container?.running) await this.ctx.container.destroy();
			const tables = this.ctx.storage.sql
				.exec<{ name: string }>(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('computer_mutation_queue', 'computer_mutation_payload')",
				)
				.toArray();
			for (const { name } of tables) {
				// Runtime versions use _cf_ or __cf_ for protected tables; clear KV through its API.
				if (name.startsWith('_cf_') || name.startsWith('__cf_')) continue;
				this.ctx.storage.sql.exec(`DROP TABLE "${name.replaceAll('"', '""')}"`);
			}
			for (const [key] of this.ctx.storage.kv.list()) this.ctx.storage.kv.delete(key);
			this.computerInstance = undefined;
			this.computerAdapter = undefined;
			this.containerInstance = undefined;
			this.changesInstance = undefined;
		});
	}

	async restoreSnapshots(selections: Array<{ snapshotId: string; path?: string }>) {
		return this.mutate('restoreSnapshots', [selections], () => restoreComputerSnapshots(this.workspace, selections));
	}

	async resolveWorkspaceReview(options: ComputerReviewOptions): Promise<boolean> {
		return this.mutate('resolveWorkspaceReview', [options], () => resolveComputerReview(this.workspace, options));
	}

	/** Export the working tree (excluding `.git`) for cloning into another project. */
	async exportTree(): Promise<Array<{ path: string; content: Uint8Array }>> {
		return withSpan('fs.exportTree', () => this.exportTreeInner());
	}

	private async exportTreeInner(): Promise<Array<{ path: string; content: Uint8Array }>> {
		const paths = await this.workspace._getAllPaths();
		const files: Array<{ path: string; content: Uint8Array }> = [];
		for (const path of paths) {
			if (path === '/.git' || path.startsWith('/.git/')) continue;
			const info = await this.workspace.stat(path);
			if (!info || info.type !== 'file') continue;
			const content = await this.workspace.readFileBytes(path);
			if (content) files.push({ path, content });
		}
		return files;
	}

	/** Import a working tree exported by {@link exportTree}. */
	async importTree(files: ReadonlyArray<{ path: string; content: Uint8Array }>): Promise<void> {
		return this.mutate<Awaited<ReturnType<ProjectFilesystem['importTree']>>>('importTree', [files], async () => {
			for (const file of files) {
				await this.workspace.writeFileBytes(file.path, file.content);
			}
			this.ctx.storage.kv.put('initialized', true);
		});
	}

	// =========================================================================
	// Git RPC surface — each method returns route-ready payloads.
	// =========================================================================
	async gitStatus(): Promise<GitStatusResponse> {
		return this.git().status();
	}
	async gitInitialCommit(author: GitAuthor): Promise<void> {
		return this.mutate<Awaited<ReturnType<ProjectFilesystem['gitInitialCommit']>>>('gitInitialCommit', [author], async () => {
			await this.git().initAndCommit('Initial commit', author);
		});
	}
	async gitInit(author: GitAuthor): Promise<{ success: true }> {
		return this.mutate<Awaited<ReturnType<ProjectFilesystem['gitInit']>>>('gitInit', [author], async () => {
			await this.git().initAndCommit('Initial commit', author);
			return { success: true };
		});
	}
	async gitStage(paths: string[]): Promise<{ success: true; gitStatus: GitStatusResponse }> {
		return this.mutate<Awaited<ReturnType<ProjectFilesystem['gitStage']>>>('gitStage', [paths], async () => {
			return { success: true, gitStatus: await this.git().stage(paths) };
		});
	}
	async gitUnstage(paths: string[]): Promise<{ success: true; gitStatus: GitStatusResponse }> {
		return this.mutate<Awaited<ReturnType<ProjectFilesystem['gitUnstage']>>>('gitUnstage', [paths], async () => {
			return { success: true, gitStatus: await this.git().unstage(paths) };
		});
	}
	async gitStageAll(): Promise<{ success: true; gitStatus: GitStatusResponse }> {
		return this.mutate<Awaited<ReturnType<ProjectFilesystem['gitStageAll']>>>('gitStageAll', [], async () => {
			return { success: true, gitStatus: await this.git().stageAll() };
		});
	}
	async gitUnstageAll(): Promise<{ success: true; gitStatus: GitStatusResponse }> {
		return this.mutate<Awaited<ReturnType<ProjectFilesystem['gitUnstageAll']>>>('gitUnstageAll', [], async () => {
			return { success: true, gitStatus: await this.git().unstageAll() };
		});
	}
	async gitDiscard(path: string): Promise<{ success: true; gitStatus: GitStatusResponse }> {
		return this.mutate<Awaited<ReturnType<ProjectFilesystem['gitDiscard']>>>('gitDiscard', [path], async () => {
			return { success: true, gitStatus: await this.git().discard(path) };
		});
	}
	async gitDiscardAll(): Promise<{ success: true; gitStatus: GitStatusResponse }> {
		return this.mutate<Awaited<ReturnType<ProjectFilesystem['gitDiscardAll']>>>('gitDiscardAll', [], async () => {
			return { success: true, gitStatus: await this.git().discardAll() };
		});
	}
	async gitCommit(message: string, author: GitAuthor): Promise<{ objectId: string; gitStatus: GitStatusResponse }> {
		return this.mutate<Awaited<ReturnType<ProjectFilesystem['gitCommit']>>>('gitCommit', [message, author], async () => {
			return this.git().commit(message, author);
		});
	}
	async gitLog(reference: string, depth: number): Promise<{ commits: GitCommitEntry[] }> {
		return { commits: await this.git().log(reference, depth) };
	}
	async gitBranches(): Promise<{ branches: GitBranchInfo[]; current: string | undefined }> {
		return this.git().branches();
	}
	async gitCreateBranch(name: string, checkout: boolean): Promise<{ success: true }> {
		return this.mutate<Awaited<ReturnType<ProjectFilesystem['gitCreateBranch']>>>('gitCreateBranch', [name, checkout], async () => {
			await this.git().createBranch(name, checkout);
			return { success: true };
		});
	}
	async gitDeleteBranch(name: string): Promise<{ success: true }> {
		return this.mutate<Awaited<ReturnType<ProjectFilesystem['gitDeleteBranch']>>>('gitDeleteBranch', [name], async () => {
			await this.git().deleteBranch(name);
			return { success: true };
		});
	}
	async gitRenameBranch(oldName: string, newName: string): Promise<{ success: true }> {
		return this.mutate<Awaited<ReturnType<ProjectFilesystem['gitRenameBranch']>>>('gitRenameBranch', [oldName, newName], async () => {
			await this.git().renameBranch(oldName, newName);
			return { success: true };
		});
	}
	async gitCheckout(reference: string): Promise<{ success: true; gitStatus: GitStatusResponse }> {
		return this.mutate<Awaited<ReturnType<ProjectFilesystem['gitCheckout']>>>('gitCheckout', [reference], async () => {
			return { success: true, gitStatus: await this.git().checkout(reference) };
		});
	}
	async gitMerge(branch: string): Promise<GitMergeResult & { gitStatus: GitStatusResponse }> {
		return this.mutate<Awaited<ReturnType<ProjectFilesystem['gitMerge']>>>('gitMerge', [branch], async () => {
			return this.git().merge(branch);
		});
	}
	async gitTags(): Promise<{ tags: string[] }> {
		return { tags: await this.git().tags() };
	}
	async gitCreateTag(name: string, reference?: string): Promise<{ success: true }> {
		return this.mutate<Awaited<ReturnType<ProjectFilesystem['gitCreateTag']>>>('gitCreateTag', [name, reference], async () => {
			await this.git().createTag(name, reference);
			return { success: true };
		});
	}
	async gitDeleteTag(name: string): Promise<{ success: true }> {
		return this.mutate<Awaited<ReturnType<ProjectFilesystem['gitDeleteTag']>>>('gitDeleteTag', [name], async () => {
			await this.git().deleteTag(name);
			return { success: true };
		});
	}
	async gitDiff(path: string): Promise<{ diff: GitFileDiff }> {
		return { diff: await this.git().diffWorkingFile(path) };
	}
	async gitDiffCommit(objectId: string): Promise<{ files: GitFileDiff[] }> {
		const changes = await this.git().diffCommit(objectId);
		return { files: changes.map((change) => ({ path: change.path, status: change.status, hunks: [] })) };
	}
	async gitDiffFile(objectId: string, path: string): Promise<{ diff: GitFileDiff }> {
		return { diff: await this.git().diffFileAtCommit(objectId, path) };
	}
}
