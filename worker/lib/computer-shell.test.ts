import { Workspace as Computer } from '@cloudflare/computer';
import { ShellWorker, WorkerShellBackend } from '@cloudflare/computer/backends/worker-shell';
import { createExecutionContext, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { drainComputerOutput } from './computer-execution';
import { computerStorage } from './computer-storage';
import { ComputerWorkspace } from './computer-workspace';
import { WorkspaceFsAdapter } from './workspace-fs-adapter';

class OfflineShell extends ShellWorker {
	protected readonly shellOptions = {
		fetch: async () => {
			throw new Error('Direct networking is disabled');
		},
	};
}
describe('Computer isolate shell parity', () => {
	it('uses the configured Git client against the project tree while blocking remote commands', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (project, state) => {
			await project.writeFileContent('/source.txt', 'baseline');
			state.storage.sql.exec("INSERT INTO computer_mutation_queue (operation, arguments, status) VALUES ('computerExec', '[]', 'running')");
			using workspace = await project.__getWorkspaceStub();
			for (const argv of [['init'], ['add', 'source.txt'], ['commit', '-m', 'baseline']]) {
				const result = await workspace.git.cli({
					argv,
					cwd: '/project',
					env: { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com' },
				});
				expect(result.exitCode, result.stderr).toBe(0);
			}
			await workspace.fs.writeFile('/source.txt', 'changed');
			const status = await workspace.git.cli({ argv: ['status', '--short'], cwd: '/workspace' });
			expect(status.exitCode, status.stderr).toBe(0);
			expect(status.stdout).toContain('source.txt');
			const diff = await workspace.git.cli({ argv: ['-C', '/project', 'diff', '--', 'source.txt'], cwd: '/workspace' });
			expect(diff.exitCode, diff.stderr).toBe(0);
			expect(diff.stdout).toContain('-baseline');
			expect(diff.stdout).toContain('+changed');
			for (const argv of [['fetch'], ['-C', '/project', 'fetch']]) {
				await expect((async () => workspace.git.cli({ argv, cwd: '/workspace' }))()).rejects.toThrow('networking is disabled');
			}
			state.storage.sql.exec("UPDATE computer_mutation_queue SET status = 'complete'");
			expect(await project.gitStatus()).toMatchObject({ initialized: true, entries: [{ path: 'source.txt' }] });
		});
	});

	it('reads and writes the same SQLite tree as editor, Git and state adapters', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (_instance, state) => {
			const shell = new OfflineShell(createExecutionContext(), { HOST: { getWorkspace: async () => computer.stub() } });
			const computer = new Computer({
				storage: computerStorage(state.storage),
				backends: [
					new WorkerShellBackend({ id: 'shell', source: { type: 'external-runtime', connect: () => shell }, egress: { mode: 'none' } }),
				],
			});
			const workspace = new ComputerWorkspace(computer);
			await workspace.writeFile('/src/input.txt', 'TODO one\nTODO two\n');
			const filesystem = new WorkspaceFsAdapter(workspace);
			await filesystem.chmod('/src/input.txt', 0o755);
			const stat = await filesystem.stat('/src/input.txt');
			expect(stat.mode & 0o777).toBe(0o755);
			const info = await workspace.stat('/src/input.txt');
			expect(info?.mimeType).toBe('text/plain');
			const result = await drainComputerOutput(
				await computer.runtime.exec('cat input.txt | grep TODO | wc -l; printf generated > output.txt', {
					backend: 'shell',
					cwd: '/workspace/src',
					timeoutMs: 30_000,
					encoding: 'utf8',
				}),
				async () => {},
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe('2');
			expect(await workspace.readFile('/project/src/output.txt')).toBe('generated');
			await workspace.symlink('/src/output.txt', '/link');
			expect(await workspace.readlink('/link')).toBe('/src/output.txt');
			expect(await workspace.readFile('/link')).toBe('generated');
			const denied = await drainComputerOutput(
				await computer.runtime.exec('curl https://example.com', {
					backend: 'shell',
					cwd: '/workspace',
					timeoutMs: 30_000,
					encoding: 'utf8',
				}),
				async () => {},
			);
			expect(denied.exitCode).not.toBe(0);
			await computer.close();
		});
	});
});
