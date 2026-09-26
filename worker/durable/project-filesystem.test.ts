import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { PREVIEW_BOOTSTRAP_INPUTS } from '../lib/preview-bootstrap';
import { hashSnapshot } from '../lib/snapshot-hash';

import type { ProjectFilesystem } from './project-filesystem';

function getFilesystemStub(name: string): DurableObjectStub<ProjectFilesystem> {
	const namespace = env.DurableObjectFilesystem as DurableObjectNamespace<ProjectFilesystem>;
	return namespace.getByName(name);
}

async function readViaMount(stub: DurableObjectStub<ProjectFilesystem>, path: string): Promise<string> {
	const data = await stub.wsReadFile(path);
	return data ?? '';
}

describe('ProjectFilesystem writes', () => {
	it('writeFileContent persists non-empty content and creates parent directories', async () => {
		const stub = getFilesystemStub('test-fs-direct-single');
		const content = 'export const value = 42;\n';

		await stub.writeFileContent('/src/index.ts', content);

		expect(await readViaMount(stub, '/src/index.ts')).toBe(content);
	});

	it('writeFiles seeds a full project in one RPC call with intact content', async () => {
		const stub = getFilesystemStub('test-fs-direct-multi');
		const files = [
			{ path: '/package.json', content: '{\n\t"name": "generated-name"\n}\n' },
			{ path: '/worker/index.ts', content: '// Worker entry point\nexport default { fetch: () => new Response("ok") };\n' },
			{ path: '/src/app.tsx', content: 'export function App() {\n\treturn null;\n}\n' },
			{ path: '/.initialized', content: '1' },
		];

		await stub.writeFiles(files);

		for (const file of files) {
			expect(await readViaMount(stub, file.path), `content of ${file.path}`).toBe(file.content);
		}
		await expect(stub.projectExists()).resolves.toBe(true);
	});

	it('writeFileContent overwrites existing content (truncate semantics)', async () => {
		const stub = getFilesystemStub('test-fs-direct-overwrite');
		await stub.writeFileContent('/notes.txt', 'first version that is long');
		await stub.writeFileContent('/notes.txt', 'second');

		expect(await readViaMount(stub, '/notes.txt')).toBe('second');
	});
});

describe('ProjectFilesystem preview bootstrap', () => {
	it('collects existence, wrangler, and the runtime probe in one call', async () => {
		const stub = getFilesystemStub('test-fs-bootstrap');
		await stub.writeFileContent('/package.json', '{\n\t"name": "app"\n}\n');
		await stub.writeFileContent('/index.html', '<!doctype html>\n');
		await stub.writeFileContent('/wrangler.jsonc', '{ "assets": { "not_found_handling": "single-page-application" } }');
		await stub.writeFileContent('/app/page.tsx', 'export default () => null;\n');

		const result = await stub.collectPreviewBootstrap(PREVIEW_BOOTSTRAP_INPUTS);

		expect(result.exists).toBe(true);
		expect(result.packageJson).toBe('{\n\t"name": "app"\n}\n');
		expect(result.indexHtml).toBe('<!doctype html>\n');
		expect(result.wranglerJsonc).toBe('{ "assets": { "not_found_handling": "single-page-application" } }');
		expect(result.routerFirstEntries.app).toBe('page.tsx');
		expect(result.routerFirstEntries.pages).toBeUndefined();
		expect(result.routerFirstEntries.src).toBeUndefined();
		// The bootstrap hash must equal the standalone snapshot hash — the preview
		// host trusts this passed-through value to select a warm build without a
		// second cross-DO hop.
		expect(result.snapshotHash).toBe(await hashSnapshot(await stub.collectProjectSnapshot(PREVIEW_BOOTSTRAP_INPUTS.excludedDirectories)));
	});

	it('reports a non-existent project with undefined contents', async () => {
		const stub = getFilesystemStub('test-fs-bootstrap-empty');

		const result = await stub.collectPreviewBootstrap(PREVIEW_BOOTSTRAP_INPUTS);

		expect(result.exists).toBe(false);
		expect(result.packageJson).toBeUndefined();
		expect(result.indexHtml).toBeUndefined();
		expect(result.wranglerJsonc).toBeUndefined();
		expect(result.routerFirstEntries).toEqual({ app: undefined, pages: undefined, src: undefined });
	});
});

describe('ProjectFilesystem project snapshot', () => {
	it('collects the whole text tree in one call, excluding build/tooling dirs', async () => {
		const stub = getFilesystemStub('test-fs-snapshot');
		await stub.writeFileContent('/package.json', '{\n\t"name": "app"\n}\n');
		await stub.writeFileContent('/app/counter.tsx', 'export default () => null;\n');
		await stub.writeFileContent('/app/nested/util.ts', 'export const x = 1;\n');
		// Excluded: build output, dependencies, git, and hidden entries.
		await stub.writeFileContent('/dist/bundle.js', 'ignored\n');
		await stub.writeFileContent('/node_modules/pkg/index.js', 'ignored\n');
		await stub.wsWriteFile('/.git/config', '[core]\n');

		const snapshot = await stub.collectProjectSnapshot(['node_modules', 'dist', '.git', '.initialized', '.agent']);

		expect(snapshot['/package.json']).toBe('{\n\t"name": "app"\n}\n');
		expect(snapshot['/app/counter.tsx']).toBe('export default () => null;\n');
		expect(snapshot['/app/nested/util.ts']).toBe('export const x = 1;\n');
		expect(snapshot['/dist/bundle.js']).toBeUndefined();
		expect(snapshot['/node_modules/pkg/index.js']).toBeUndefined();
		expect(Object.keys(snapshot).some((path) => path.startsWith('/.git'))).toBe(false);
	});

	it('returns an empty snapshot for an empty project', async () => {
		const stub = getFilesystemStub('test-fs-snapshot-empty');
		expect(await stub.collectProjectSnapshot(['node_modules', 'dist', '.git'])).toEqual({});
	});

	it('snapshotHash equals the hash of the collected snapshot (tree-free probe) and tracks edits', async () => {
		const stub = getFilesystemStub('test-fs-snapshot-hash');
		const excluded = ['node_modules', 'dist', '.git', '.initialized', '.agent'];
		await stub.writeFileContent('/package.json', '{\n\t"name": "app"\n}\n');
		await stub.writeFileContent('/app/page.tsx', 'export default () => null;\n');

		const snapshot = await stub.collectProjectSnapshot(excluded);
		const hash = await stub.snapshotHash(excluded);
		// The probe must match hashing the full snapshot — the worker relies on this
		// equivalence to trust a warm build cache hit without fetching the tree.
		expect(hash).toBe(await hashSnapshot(snapshot));

		await stub.writeFileContent('/app/page.tsx', 'export default () => "changed";\n');
		expect(await stub.snapshotHash(excluded)).not.toBe(hash);
	});
});

describe('ProjectFilesystem change drain', () => {
	it('tracks Git configuration and GitHub files without exposing repository internals', async () => {
		const stub = getFilesystemStub('test-fs-drain-git-adjacent');
		const paths = ['/.gitignore', '/.gitattributes', '/.github/workflows/ci.yml'];
		for (const path of paths) {
			await stub.wsWriteFile(path, 'before');
			await stub.wsWriteFile(path, 'after', 'session-git-adjacent');
		}
		await stub.wsWriteFile('/.git/config', '[core]', 'session-git-adjacent');

		const changes = await stub.drainWorkspaceChanges('session-git-adjacent');
		expect(changes.map((change) => change.path).toSorted()).toEqual(paths.toSorted());
		for (const change of changes) {
			expect(change).toMatchObject({ type: 'update', beforeContent: 'before', afterContent: 'after' });
		}
	});

	it('drains the writes for a session and clears them', async () => {
		const stub = getFilesystemStub('test-fs-drain');

		await stub.wsWriteFile('/src/a.ts', 'export const a = 1;\n', 'session-drain');
		await stub.wsWriteFile('/src/b.ts', 'export const b = 2;\n', 'session-drain');

		const changes = await stub.drainWorkspaceChanges('session-drain');
		const paths = changes.map((change) => change.path);
		expect(paths).toContain('/src/a.ts');
		expect(paths).toContain('/src/b.ts');

		// Draining a second time returns nothing — the writer's rows were cleared.
		expect(await stub.drainWorkspaceChanges('session-drain')).toEqual([]);
	});

	it('returns nothing for an unattributed (no writerId) drain', async () => {
		const stub = getFilesystemStub('test-fs-drain-unattributed');

		await stub.wsWriteFile('/src/loose.ts', 'export const loose = 1;\n');

		// Changes are only ever surfaced per session; there is no global drain.
		expect(await stub.drainWorkspaceChanges()).toEqual([]);
	});

	it('excludes .git writes from the drain', async () => {
		const stub = getFilesystemStub('test-fs-drain-git');

		await stub.wsWriteFile('/.git/config', '[core]\n', 'session-git');
		await stub.wsWriteFile('/src/c.ts', 'export const c = 3;\n', 'session-git');

		const changes = await stub.drainWorkspaceChanges('session-git');
		const paths = changes.map((change) => change.path);
		expect(paths).toContain('/src/c.ts');
		expect(paths.some((path) => path.startsWith('/.git'))).toBe(false);
	});
});

describe('ProjectFilesystem per-session change drain', () => {
	it('attributes changes to the writing session only', async () => {
		const stub = getFilesystemStub('test-fs-session-attr');

		await stub.wsWriteFile('/a.ts', 'export const a = 1;\n', 'session-A');
		await stub.wsWriteFile('/b.ts', 'export const b = 2;\n', 'session-B');

		const a = await stub.drainWorkspaceChanges('session-A');
		const b = await stub.drainWorkspaceChanges('session-B');

		expect(a.map((change) => change.path)).toEqual(['/a.ts']);
		expect(b.map((change) => change.path)).toEqual(['/b.ts']);
		// A second drain for either session is empty (state cleared).
		expect(await stub.drainWorkspaceChanges('session-A')).toEqual([]);
	});

	it('captures beforeContent for an edit', async () => {
		const stub = getFilesystemStub('test-fs-session-edit');
		await stub.writeFileContent('/edit.ts', 'old\n');

		await stub.wsWriteFile('/edit.ts', 'new\n', 'session-1');

		const changes = await stub.drainWorkspaceChanges('session-1');
		expect(changes).toEqual([{ type: 'update', path: '/edit.ts', entryType: 'file', beforeContent: 'old\n', afterContent: 'new\n' }]);
	});

	it('drops a no-op write (identical content) so it never shows as a phantom edit', async () => {
		const stub = getFilesystemStub('test-fs-session-noop');
		await stub.writeFileContent('/same.ts', 'unchanged\n');

		// Read-then-rewrite with identical content (the codemode phantom-edit case).
		await stub.wsWriteFile('/same.ts', 'unchanged\n', 'session-1');

		expect(await stub.drainWorkspaceChanges('session-1')).toEqual([]);
	});

	it('reports a create with no beforeContent', async () => {
		const stub = getFilesystemStub('test-fs-session-create');

		await stub.wsWriteFile('/new.ts', 'fresh\n', 'session-1');

		const changes = await stub.drainWorkspaceChanges('session-1');
		expect(changes).toEqual([{ type: 'create', path: '/new.ts', entryType: 'file', beforeContent: undefined, afterContent: 'fresh\n' }]);
	});

	it('reports a delete with no afterContent', async () => {
		const stub = getFilesystemStub('test-fs-session-delete');
		await stub.writeFileContent('/gone.ts', 'bye\n');

		await stub.wsRm('/gone.ts', false, false, 'session-1');

		const changes = await stub.drainWorkspaceChanges('session-1');
		expect(changes).toEqual([{ type: 'delete', path: '/gone.ts', entryType: 'file', beforeContent: 'bye\n', afterContent: undefined }]);
	});

	it('keeps two sessions editing the same file independent, each with its own baseline', async () => {
		const stub = getFilesystemStub('test-fs-session-overlap');
		await stub.writeFileContent('/shared.ts', 'base\n');

		// Session A edits first; its baseline is the original content.
		await stub.wsWriteFile('/shared.ts', 'from-A\n', 'session-A');
		// Session B edits next; its baseline is whatever was live when it first touched.
		await stub.wsWriteFile('/shared.ts', 'from-B\n', 'session-B');

		const a = await stub.drainWorkspaceChanges('session-A');
		const b = await stub.drainWorkspaceChanges('session-B');

		expect(a).toEqual([{ type: 'update', path: '/shared.ts', entryType: 'file', beforeContent: 'base\n', afterContent: 'from-B\n' }]);
		expect(b).toEqual([{ type: 'update', path: '/shared.ts', entryType: 'file', beforeContent: 'from-A\n', afterContent: 'from-B\n' }]);
	});

	it('persists the per-session checkpoint across a Durable Object eviction', async () => {
		const stub = getFilesystemStub('test-fs-durable-checkpoint');
		await stub.writeFileContent('/keep.ts', 'old\n');

		// Capture the baseline ('old') by editing under a session.
		await stub.wsWriteFile('/keep.ts', 'new\n', 'session-durable');

		// Simulate an eviction: discard the DO's in-memory state; SQLite persists.
		// abort() breaks this stub's output gate, so reconnect with a fresh stub.
		await runInDurableObject(stub, (_instance, state) => {
			state.abort('simulated eviction');
		}).catch(() => {});

		// The baseline survives in SQLite, so the diff is still attributed and
		// correct even though the in-memory checkpoint state was discarded.
		const freshStub = getFilesystemStub('test-fs-durable-checkpoint');
		const changes = await freshStub.drainWorkspaceChanges('session-durable');
		expect(changes).toEqual([{ type: 'update', path: '/keep.ts', entryType: 'file', beforeContent: 'old\n', afterContent: 'new\n' }]);
	});
});
