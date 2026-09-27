import { Workspace } from '@cloudflare/shell';
import { DurableObject } from 'cloudflare:workers';

import { GitService } from './git-service';
import { generateProjectId } from '../lib/project-id';
import { hashSnapshot } from '../lib/snapshot-hash';
import { withSpan } from '../lib/tracing';
import { WorkspaceFsAdapter } from '../lib/workspace-fs-adapter';

import type { GitAuthor, GitStatusResponse } from './git-service';
import type { PreviewBootstrap, PreviewBootstrapInputs } from '../lib/preview-bootstrap';
import type { FileInfo, FileStat, WorkspaceChangeEvent } from '@cloudflare/shell';
import type { ProjectFilesystemRpc } from '@shared/project-filesystem-rpc';
import type { GitBranchInfo, GitCommitEntry, GitFileDiff, GitMergeResult } from '@shared/types';

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
interface DrainedWorkspaceChange {
	type: WorkspaceChangeEvent['type'];
	path: string;
	entryType: WorkspaceChangeEvent['entryType'];
	beforeContent?: string;
	afterContent?: string;
}

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
const WRITER_CHANGE_TABLE = 'agent_writer_change';

/**
 * Project filesystem Durable Object.
 *
 * A single durable `@cloudflare/shell` `Workspace` (SQLite + R2 spillover) holds
 * both the working tree and a real `.git`. Git operations run here, locally,
 * against that Workspace via {@link GitService}; Cloudflare Artifacts remains
 * the remote. There is no in-memory filesystem.
 */
export class ProjectFilesystem extends DurableObject<Env> implements ProjectFilesystemRpc {
	private workspaceInstance?: Workspace;
	/** Whether the per-writer change table has been created this isolate. */
	private writerTableReady = false;

	private get projectId(): string {
		return generateProjectId(this.ctx.id);
	}

	private get workspace(): Workspace {
		this.workspaceInstance ??= new Workspace({
			sql: this.ctx.storage.sql,
			r2: this.env.STORAGE_BUCKET,
			r2Prefix: `workspace/${this.projectId}`,
			name: () => this.projectId,
		});
		return this.workspaceInstance;
	}

	/** Create the per-writer change table once per isolate (idempotent). */
	private ensureWriterTable(): void {
		if (this.writerTableReady) return;
		this.ctx.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS ${WRITER_CHANGE_TABLE} (writer_id TEXT NOT NULL, path TEXT NOT NULL, baseline TEXT, PRIMARY KEY (writer_id, path))`,
		);
		this.writerTableReady = true;
	}

	/**
	 * Record a path's pre-edit content for `writerId`, once per path per drain
	 * window. Called BEFORE the mutation so the captured content is the true
	 * baseline. Reads that fail (new file, directory, binary) store NULL.
	 */
	private async captureBaseline(writerId: string, path: string): Promise<void> {
		if (path === '/.git' || path.startsWith('/.git/')) return;
		this.ensureWriterTable();
		const existing = this.ctx.storage.sql
			.exec(`SELECT 1 FROM ${WRITER_CHANGE_TABLE} WHERE writer_id = ? AND path = ? LIMIT 1`, writerId, path)
			.toArray();
		if (existing.length > 0) return;
		let content: string | undefined;
		try {
			content = (await this.workspace.readFile(path)) ?? undefined;
		} catch {
			content = undefined;
		}
		if (content === undefined) {
			// No readable pre-edit content — leave `baseline` NULL (a create).
			this.ctx.storage.sql.exec(`INSERT OR IGNORE INTO ${WRITER_CHANGE_TABLE} (writer_id, path) VALUES (?, ?)`, writerId, path);
			return;
		}
		this.ctx.storage.sql.exec(
			`INSERT OR IGNORE INTO ${WRITER_CHANGE_TABLE} (writer_id, path, baseline) VALUES (?, ?, ?)`,
			writerId,
			path,
			content,
		);
	}

	/**
	 * Mark `path` as touched by `writerId` (after the mutation completed). Ensures
	 * a row exists even if the baseline capture was skipped; `INSERT OR IGNORE`
	 * never clobbers a baseline already captured before the write.
	 */
	private markTouched(writerId: string, path: string): void {
		if (path === '/.git' || path.startsWith('/.git/')) return;
		this.ensureWriterTable();
		this.ctx.storage.sql.exec(
			`INSERT OR IGNORE INTO ${WRITER_CHANGE_TABLE} (writer_id, path, baseline) VALUES (?, ?, NULL)`,
			writerId,
			path,
		);
	}

	/**
	 * Drain the changes attributed to `writerId` (an agent session), each enriched
	 * with before/after content and with true no-ops (content unchanged) dropped.
	 * Reads the durable per-writer baselines, then clears that writer's rows.
	 *
	 * Returns `[]` when no `writerId` is given — changes are only ever surfaced
	 * per session; there is no unattributed/global drain.
	 *
	 * Concurrent same-file boundary: `afterContent` is the CURRENT content, so if
	 * two sessions edit the same path, each session's diff reflects its own
	 * baseline but the shared latest content. Non-overlapping paths (the common
	 * multi-agent case) are attributed exactly.
	 */
	async drainWorkspaceChanges(writerId?: string): Promise<DrainedWorkspaceChange[]> {
		if (writerId === undefined) return [];
		this.ensureWriterTable();
		const rows = this.ctx.storage.sql
			.exec<{ path: string; baseline: string | null }>(`SELECT path, baseline FROM ${WRITER_CHANGE_TABLE} WHERE writer_id = ?`, writerId)
			.toArray();
		this.ctx.storage.sql.exec(`DELETE FROM ${WRITER_CHANGE_TABLE} WHERE writer_id = ?`, writerId);

		const result: DrainedWorkspaceChange[] = [];
		for (const row of rows) {
			const path = row.path;
			const beforeContent = row.baseline ?? undefined;
			let afterContent: string | undefined;
			try {
				afterContent = (await this.workspace.readFile(path)) ?? undefined;
			} catch {
				afterContent = undefined;
			}

			// Nothing on either side — not a real change.
			if (beforeContent === undefined && afterContent === undefined) continue;
			// Content unchanged — a no-op write (e.g. read-then-rewrite). Drop it so
			// it never surfaces as a phantom "edited" entry with an empty diff.
			if (beforeContent === afterContent) continue;

			const type: WorkspaceChangeEvent['type'] = afterContent === undefined ? 'delete' : beforeContent === undefined ? 'create' : 'update';
			result.push({ type, path, entryType: 'file', beforeContent, afterContent });
		}
		return result;
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
		if (writerId !== undefined) await this.captureBaseline(writerId, path);
		await this.workspace.writeFile(path, content);
		if (writerId !== undefined) this.markTouched(writerId, path);
	}
	async wsWriteFileBytes(path: string, data: Uint8Array, writerId?: string): Promise<void> {
		if (writerId !== undefined) await this.captureBaseline(writerId, path);
		await this.workspace.writeFileBytes(path, data);
		if (writerId !== undefined) this.markTouched(writerId, path);
	}
	async wsAppendFile(path: string, content: string, writerId?: string): Promise<void> {
		if (writerId !== undefined) await this.captureBaseline(writerId, path);
		await this.workspace.appendFile(path, content);
		if (writerId !== undefined) this.markTouched(writerId, path);
	}
	async wsExists(path: string): Promise<boolean> {
		return this.workspace.exists(path);
	}
	async wsStat(path: string): Promise<FileStat | null> {
		return this.workspace.stat(path);
	}
	async wsLstat(path: string): Promise<FileStat | null> {
		return this.workspace.lstat(path);
	}
	async wsMkdir(path: string, recursive: boolean): Promise<void> {
		await this.workspace.mkdir(path, { recursive });
	}
	async wsReadDir(path: string): Promise<FileInfo[]> {
		return this.workspace.readDir(path);
	}
	async wsRm(path: string, recursive: boolean, force: boolean, writerId?: string): Promise<void> {
		if (writerId !== undefined) await this.captureBaseline(writerId, path);
		await this.workspace.rm(path, { recursive, force });
		if (writerId !== undefined) this.markTouched(writerId, path);
	}
	async wsCp(source: string, destination: string, recursive: boolean, writerId?: string): Promise<void> {
		if (writerId !== undefined) await this.captureBaseline(writerId, destination);
		await this.workspace.cp(source, destination, { recursive });
		if (writerId !== undefined) this.markTouched(writerId, destination);
	}
	async wsMv(source: string, destination: string, writerId?: string): Promise<void> {
		if (writerId !== undefined) {
			await this.captureBaseline(writerId, source);
			await this.captureBaseline(writerId, destination);
		}
		await this.workspace.mv(source, destination);
		if (writerId !== undefined) {
			this.markTouched(writerId, source);
			this.markTouched(writerId, destination);
		}
	}
	async wsSymlink(target: string, linkPath: string): Promise<void> {
		await this.workspace.symlink(target, linkPath);
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
		const [exists, wranglerJsonc, packageJson, indexHtml, snapshotHash, ...directoryEntries] = await Promise.all([
			this.projectExists(),
			this.workspace.readFile(inputs.wranglerPath).then((value) => value ?? undefined),
			this.workspace.readFile(inputs.packageJsonPath).then((value) => value ?? undefined),
			this.workspace.readFile(inputs.indexHtmlPath).then((value) => value ?? undefined),
			hashSnapshot(await this.buildSnapshotRecord(inputs.excludedDirectories)),
			...inputs.routerDirectories.map((directory) => this.workspace.readDir(`/${directory}`).catch(() => [])),
		]);
		const routerFirstEntries: Record<string, string | undefined> = {};
		for (const [index, directory] of inputs.routerDirectories.entries()) {
			routerFirstEntries[directory] = directoryEntries[index][0]?.name;
		}
		return { exists, wranglerJsonc, packageJson, indexHtml, routerFirstEntries, snapshotHash };
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
		await this.workspace.writeFile(path, content);
		this.ctx.storage.kv.put('initialized', true);
	}

	async writeFiles(files: ReadonlyArray<SeedFile>): Promise<void> {
		for (const file of files) {
			await this.workspace.writeFile(file.path, file.content);
		}
		this.ctx.storage.kv.put('initialized', true);
	}

	async destroyStorage(): Promise<void> {
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
		this.workspaceInstance = undefined;
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
		for (const file of files) {
			await this.workspace.writeFileBytes(file.path, file.content);
		}
		this.ctx.storage.kv.put('initialized', true);
	}

	// =========================================================================
	// Git RPC surface — each method returns route-ready payloads.
	// =========================================================================
	async gitStatus(): Promise<GitStatusResponse> {
		return this.git().status();
	}
	async gitInitialCommit(author: GitAuthor): Promise<void> {
		await this.git().initAndCommit('Initial commit', author);
	}
	async gitInit(author: GitAuthor): Promise<{ success: true }> {
		await this.git().initAndCommit('Initial commit', author);
		return { success: true };
	}
	async gitStage(paths: string[]): Promise<{ success: true; gitStatus: GitStatusResponse }> {
		return { success: true, gitStatus: await this.git().stage(paths) };
	}
	async gitUnstage(paths: string[]): Promise<{ success: true; gitStatus: GitStatusResponse }> {
		return { success: true, gitStatus: await this.git().unstage(paths) };
	}
	async gitStageAll(): Promise<{ success: true; gitStatus: GitStatusResponse }> {
		return { success: true, gitStatus: await this.git().stageAll() };
	}
	async gitUnstageAll(): Promise<{ success: true; gitStatus: GitStatusResponse }> {
		return { success: true, gitStatus: await this.git().unstageAll() };
	}
	async gitDiscard(path: string): Promise<{ success: true; gitStatus: GitStatusResponse }> {
		return { success: true, gitStatus: await this.git().discard(path) };
	}
	async gitDiscardAll(): Promise<{ success: true; gitStatus: GitStatusResponse }> {
		return { success: true, gitStatus: await this.git().discardAll() };
	}
	async gitCommit(message: string, author: GitAuthor): Promise<{ objectId: string; gitStatus: GitStatusResponse }> {
		return this.git().commit(message, author);
	}
	async gitLog(reference: string, depth: number): Promise<{ commits: GitCommitEntry[] }> {
		return { commits: await this.git().log(reference, depth) };
	}
	async gitBranches(): Promise<{ branches: GitBranchInfo[]; current: string | undefined }> {
		return this.git().branches();
	}
	async gitCreateBranch(name: string, checkout: boolean): Promise<{ success: true }> {
		await this.git().createBranch(name, checkout);
		return { success: true };
	}
	async gitDeleteBranch(name: string): Promise<{ success: true }> {
		await this.git().deleteBranch(name);
		return { success: true };
	}
	async gitRenameBranch(oldName: string, newName: string): Promise<{ success: true }> {
		await this.git().renameBranch(oldName, newName);
		return { success: true };
	}
	async gitCheckout(reference: string): Promise<{ success: true; gitStatus: GitStatusResponse }> {
		return { success: true, gitStatus: await this.git().checkout(reference) };
	}
	async gitMerge(branch: string): Promise<GitMergeResult & { gitStatus: GitStatusResponse }> {
		return this.git().merge(branch);
	}
	async gitTags(): Promise<{ tags: string[] }> {
		return { tags: await this.git().tags() };
	}
	async gitCreateTag(name: string, reference?: string): Promise<{ success: true }> {
		await this.git().createTag(name, reference);
		return { success: true };
	}
	async gitDeleteTag(name: string): Promise<{ success: true }> {
		await this.git().deleteTag(name);
		return { success: true };
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
