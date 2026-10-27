import { Workspace as Computer } from '@cloudflare/computer';
import { ShellWorker, WorkerShellBackend } from '@cloudflare/computer/backends/worker-shell';
import { createExecutionContext, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { ComputerOutputObserver } from './computer-output-observer';
import { computerStorage } from './computer-storage';

import type { WorkspaceFilesystemStub } from '@cloudflare/computer';

class ControlledShell extends ShellWorker {
	setCommand(command: NonNullable<typeof this.bashFactoryOverride>) {
		this.bashFactoryOverride = command;
	}
}

describe('Computer execution lifecycle without Docker', () => {
	it.each([false, true])(
		'publishes before exit and keeps FIFO ownership through synchronization (disconnected: %s)',
		async (disconnected) => {
			await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (project, state) => {
				const shell = new ControlledShell(createExecutionContext(), { HOST: { getWorkspace: () => project.__getWorkspaceStub() } });
				const computer = new Computer({
					storage: computerStorage(state.storage),
					backends: [
						new WorkerShellBackend({
							id: 'container',
							source: { type: 'external-runtime', connect: () => shell },
							egress: { mode: 'none' },
						}),
					],
				});
				Reflect.set(project, 'computerInstance', computer);
				Reflect.set(project, 'getWorkspaceContainer', () => ({ setInactivityTimeout: async () => {} }));
				vi.spyOn(computer, 'push').mockImplementation(async function* () {});
				const pulling = Promise.withResolvers<void>();
				const synchronized = Promise.withResolvers<void>();
				vi.spyOn(computer, 'pull').mockImplementation(async function* () {
					pulling.resolve();
					await synchronized.promise;
					yield* [];
				});
				const id = crypto.randomUUID();
				const stream = new TransformStream<Uint8Array, Uint8Array>();
				const writer = stream.writable.getWriter();
				const execute = vi.spyOn(shell, 'exec').mockImplementation(async () => ({ id, events: stream.readable }));
				const receive = vi.fn(async () => {
					if (disconnected) throw new Error('Observer disconnected');
				});
				let finished = false;
				const execution = project
					.computerExec('streamed command', { id, backend: 'container' }, 'session', new ComputerOutputObserver(receive))
					.then((result) => {
						finished = true;
						return result;
					});
				const send = (event: object) => writer.write(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
				await send({ id, seq: 1, name: 'stdout', value: 'First 😀 line' });
				await vi.waitFor(
					() => expect(receive).toHaveBeenCalledWith(expect.objectContaining({ stdout: 'First 😀 line', stdoutBytes: 15 })),
					{ timeout: 2000 },
				);
				expect(finished).toBe(false);
				let editorFinished = false;
				const editor = project.writeFileContent('/queued.txt', 'editor').then(() => {
					editorFinished = true;
				});
				await send({ id, seq: 2, name: 'exit', value: 0 });
				await writer.close();
				await pulling.promise;
				expect(editorFinished).toBe(false);
				expect(finished).toBe(false);
				expect(state.storage.sql.exec("SELECT arguments FROM computer_mutation_queue WHERE operation = 'computerExec'").toArray()).toEqual([
					expect.objectContaining({ arguments: JSON.stringify(['streamed command', { id, backend: 'container' }, 'session']) }),
				]);
				synchronized.resolve();
				expect(await execution).toMatchObject({ stdout: 'First 😀 line', syncStatus: 'complete' });
				await editor;
				expect(await project.wsReadFile('/queued.txt')).toBe('editor');
				expect(execute).toHaveBeenCalledOnce();
				await computer.close();
			});
		},
	);
	it('ignores delayed cancellation from an earlier turn in the same session', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (project, state) => {
			await project.beginComputerSessionTurn('session', 'old-turn', 'code');
			await project.beginComputerSessionTurn('session', 'new-turn', 'code');
			await project.cancelComputerSessionExecutions('session', 'old-turn');
			expect(state.storage.kv.get('computer-session-cancelled:session')).toBeUndefined();
			await project.cancelComputerSessionExecutions('session', 'new-turn');
			expect(state.storage.kv.get('computer-session-cancelled:session')).toBe(true);
		});
	});

	it.each(['shell', 'container'])('restores managed configuration before releasing a %s execution', async (backend) => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (project, state) => {
			const shell = new ControlledShell(createExecutionContext(), { HOST: { getWorkspace: () => project.__getWorkspaceStub() } });
			const computer = new Computer({
				storage: computerStorage(state.storage),
				backends: [
					new WorkerShellBackend({ id: backend, source: { type: 'external-runtime', connect: () => shell }, egress: { mode: 'none' } }),
				],
			});
			Reflect.set(project, 'computerInstance', computer);
			vi.spyOn(computer, 'push').mockImplementation(async function* () {});
			vi.spyOn(computer, 'pull').mockImplementation(async function* () {});
			Reflect.set(project, 'getWorkspaceContainer', () => ({ setInactivityTimeout: async () => {} }));
			await project.writeFileContent('/package.json', '{"name":"preserved"}');
			await project.wsSymlink('/package.json', '/alias');
			shell.setCommand(async () => {
				using workspace = await project.__getWorkspaceStub();
				await expect(workspace.fs.writeFile('/alias', 'blocked')).rejects.toThrow('managed by the IDE');
				// A native process or Git backend can write without the shell adapter.
				await computer.fs.writeFile('/workspace/package.json', '{}');
				await computer.fs.writeFile('/workspace/source.ts', 'kept source edit');
				return { stdout: '', stderr: '', exitCode: 0 };
			});
			const result = await project.computerExec('modify configuration', { backend }, 'session');
			expect(result).toMatchObject({ status: 'failed', exitCode: 1, syncStatus: 'complete' });
			expect(result.stderr).toContain('IDE-managed files: /package.json');
			expect(await project.wsReadFile('/package.json')).toBe('{"name":"preserved"}');
			expect(await project.wsReadFile('/source.ts')).toBe('kept source edit');
			expect(state.storage.sql.exec('SELECT 1 FROM computer_protected_files').toArray()).toEqual([]);
			await computer.close();
		});
	});

	it('starts a cold container before setting its idle timeout or dispatching a command', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (project, state) => {
			const shell = new ControlledShell(createExecutionContext(), { HOST: { getWorkspace: () => project.__getWorkspaceStub() } });
			const computer = new Computer({
				storage: computerStorage(state.storage),
				backends: [
					new WorkerShellBackend({ id: 'container', source: { type: 'external-runtime', connect: () => shell }, egress: { mode: 'none' } }),
				],
			});
			Reflect.set(project, 'computerInstance', computer);
			let running = false;
			const operations: string[] = [];
			vi.spyOn(computer, 'push').mockImplementation(async function* () {
				operations.push('start');
				running = true;
				yield* [];
			});
			vi.spyOn(computer, 'pull').mockImplementation(async function* () {});
			Reflect.set(project, 'getWorkspaceContainer', () => ({
				setInactivityTimeout: async () => {
					if (!running) throw new Error('The container has not been started');
					operations.push('timeout');
				},
			}));
			shell.setCommand(async () => {
				operations.push('execute');
				return { stdout: 'started', stderr: '', exitCode: 0 };
			});
			const result = await project.computerExec('native command', { backend: 'container' }, 'session');
			expect(result).toMatchObject({ stdout: 'started', syncStatus: 'complete' });
			expect(operations.slice(0, 3)).toEqual(['start', 'timeout', 'execute']);
			await computer.close();
		});
	});

	it('releases queued editor writes after validation and container preparation fail before dispatch', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (project, state) => {
			const computer = new Computer({ storage: computerStorage(state.storage) });
			Reflect.set(project, 'computerInstance', computer);
			Reflect.set(project, 'getWorkspaceContainer', () => ({
				setInactivityTimeout: async () => {
					throw new Error('preparation failed');
				},
			}));
			const execute = vi.spyOn(computer.runtime, 'exec');
			for (const options of [
				{ id: crypto.randomUUID(), cwd: '/workspace/../..' },
				{ id: crypto.randomUUID(), inputJson: '{' },
				{ id: crypto.randomUUID(), backend: 'container' },
				{ id: crypto.randomUUID(), backend: 'shell', expectedSnapshotHash: 'outdated' },
			]) {
				const execution = project.computerExec('must not run', options, 'session');
				const editor = project.writeFileContent('/source.txt', options.id);
				await expect(execution).rejects.toThrow();
				await editor;
				expect(await project.wsReadFile('/source.txt')).toBe(options.id);
			}
			expect(execute).not.toHaveBeenCalled();
			expect(project.getComputerExecutions('session')).toEqual([]);
			expect(
				state.storage.sql.exec("SELECT 1 FROM computer_mutation_queue WHERE status IN ('running', 'sync-pending', 'queued')").toArray(),
			).toEqual([]);
			await computer.close();
		});
	});

	it('cancels before FIFO handoff, preserves attribution and returns cached outcomes without replay', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (project, state) => {
			const shell = new ControlledShell(createExecutionContext(), { HOST: { getWorkspace: () => project.__getWorkspaceStub() } });
			const computer = new Computer({
				storage: computerStorage(state.storage),
				backends: [
					new WorkerShellBackend({ id: 'shell', source: { type: 'external-runtime', connect: () => shell }, egress: { mode: 'none' } }),
				],
			});
			Reflect.set(project, 'computerInstance', computer);
			await project.writeFileContent('/source.txt', 'baseline');
			await project.registerComputerSession('first', 'code');
			await project.wsWriteFile('/source.txt', 'first edit before execution', 'first');
			let started: (() => void) | undefined;
			const ready = new Promise<void>((resolve) => {
				started = resolve;
			});
			let calls = 0;
			let retainedFilesystem: WorkspaceFilesystemStub | undefined;
			shell.setCommand(async (_command, options) => {
				calls++;
				using workspace = await project.__getWorkspaceStub();
				retainedFilesystem = workspace.fs;
				await workspace.fs.writeFile('/project/source.txt', 'partial');
				started?.();
				await new Promise<void>((resolve) => {
					options.signal?.addEventListener('abort', () => resolve(), { once: true });
				});
				return { stdout: '', stderr: 'cancelled', exitCode: 130 };
			});
			const id = crypto.randomUUID();
			const execution = project.computerExec('controlled command', { id, backend: 'shell' }, 'first');
			await ready;
			expect(await project.drainWorkspaceChanges('first')).toEqual([]);
			const session = project.wsWriteFile('/source.txt', 'second', 'second');
			const editor = project.writeFileContent('/source.txt', 'editor');
			await project.cancelComputerExecution(id, 'first');
			const result = await execution;
			await Promise.all([session, editor]);
			expect(result).toMatchObject({ status: 'cancelled', syncStatus: 'complete', exitCode: 130 });
			expect(await project.drainWorkspaceChanges('first')).toMatchObject([
				{ path: '/source.txt', beforeContent: 'baseline', afterContent: 'partial' },
			]);
			expect(await project.drainWorkspaceChanges('second')).toMatchObject([
				{ path: '/source.txt', beforeContent: 'partial', afterContent: 'second' },
			]);
			expect(await project.wsReadFile('/source.txt')).toBe('editor');
			expect(await project.computerExec('must not run again', { id }, 'first')).toEqual(result);
			expect(calls).toBe(1);
			// A new execution holds a different queue position. An old runtime facet
			// must not write under that new command's ownership.
			let active: (() => void) | undefined;
			const activeCommand = new Promise<void>((resolve) => {
				active = resolve;
			});
			shell.setCommand(async (_command, options) => {
				active?.();
				await new Promise<void>((resolve) => {
					options.signal?.addEventListener('abort', () => resolve(), { once: true });
				});
				return { stdout: '', stderr: '', exitCode: 130 };
			});
			const nextId = crypto.randomUUID();
			const next = project.computerExec('next owner', { id: nextId, backend: 'shell' }, 'second');
			await activeCommand;
			if (!retainedFilesystem) throw new Error('Missing retained runtime reference');
			const previousFilesystem = retainedFilesystem;
			await expect(
				(async () => {
					await previousFilesystem.writeFile('/source.txt', 'late write');
				})(),
			).rejects.toThrow('original execution ownership');
			await project.cancelComputerExecution(nextId, 'second');
			await next;
			await project.cancelComputerSessionExecutions('first');
			await project.registerComputerSession('first', 'code');
			await project.wsWriteFile('/source.txt', 'first edit before execution', 'first');
			const cancelled = await project.computerExec('still stopped', { id: crypto.randomUUID() }, 'first');
			expect(cancelled.status).toBe('cancelled');
			await computer.close();
		});
	});

	it('bounds output while retaining the exit status', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (project, state) => {
			const shell = new ControlledShell(createExecutionContext(), { HOST: { getWorkspace: () => project.__getWorkspaceStub() } });
			const computer = new Computer({
				storage: computerStorage(state.storage),
				backends: [
					new WorkerShellBackend({ id: 'shell', source: { type: 'external-runtime', connect: () => shell }, egress: { mode: 'none' } }),
				],
			});
			Reflect.set(project, 'computerInstance', computer);
			shell.setCommand(async () => ({ stdout: 'x'.repeat(90_000), stderr: 'y'.repeat(90_000), exitCode: 42 }));
			const result = await project.computerExec('bounded', { id: crypto.randomUUID(), backend: 'shell' }, 'session');
			expect(result.stdout).toHaveLength(60_000);
			expect(result.stderr).toHaveLength(60_000);
			expect(result).toMatchObject({ status: 'failed', exitCode: 42, syncStatus: 'complete' });
			await computer.close();
		});
	});
	it('recovers pending container synchronization after eviction without replaying the command', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (project, state) => {
			const shell = new ControlledShell(createExecutionContext(), { HOST: { getWorkspace: () => project.__getWorkspaceStub() } });
			const computer = new Computer({
				storage: computerStorage(state.storage),
				backends: [
					new WorkerShellBackend({ id: 'container', source: { type: 'external-runtime', connect: () => shell }, egress: { mode: 'none' } }),
				],
			});
			Reflect.set(project, 'computerInstance', computer);
			Reflect.set(project, 'getWorkspaceContainer', () => ({ setInactivityTimeout: async () => {} }));
			await project.writeFileContent('/source.txt', 'baseline');
			let commands = 0;
			shell.setCommand(async () => {
				commands++;
				using workspace = await project.__getWorkspaceStub();
				await workspace.fs.writeFile('/source.txt', 'command');
				return { stdout: 'saved output', stderr: '', exitCode: 0 };
			});
			const pull = vi.spyOn(computer, 'pull').mockImplementation(async function* () {
				yield await Promise.reject(new Error('bridge offline'));
			});
			const id = crypto.randomUUID();
			await expect(project.computerExec('foreground command', { id, backend: 'container' }, 'session')).rejects.toThrow(
				'cannot be released until synchronization succeeds',
			);
			expect(await project.drainWorkspaceChanges('session')).toEqual([]);
			state.storage.sql.exec(
				'INSERT INTO computer_mutation_queue (operation, arguments) VALUES (?, ?)',
				'writeFileContent',
				JSON.stringify(['/source.txt', 'editor']),
			);
			// Reconstruct the durable queue and change tracker as a fresh DO instance would.
			Reflect.set(project, 'queueInstance', undefined);
			Reflect.set(project, 'changesInstance', undefined);
			pull.mockImplementation(async function* () {
				/* Successful pull with no additional delta. */
			});
			await project.alarm();
			expect(commands).toBe(1);
			expect(await project.wsReadFile('/source.txt')).toBe('editor');
			expect(await project.drainWorkspaceChanges('session')).toMatchObject([
				{ path: '/source.txt', beforeContent: 'baseline', afterContent: 'command' },
			]);
			expect(project.getComputerExecutions('session')).toMatchObject([
				{ id, status: 'completed', result: { stdout: 'saved output', syncStatus: 'complete' } },
			]);
			pull.mockRestore();
			await computer.close();
		});
	});

	it('reattaches to the durable execution ID instead of issuing an uncertain command again', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (project, state) => {
			const shell = new ControlledShell(createExecutionContext(), { HOST: { getWorkspace: () => project.__getWorkspaceStub() } });
			const computer = new Computer({
				storage: computerStorage(state.storage),
				backends: [
					new WorkerShellBackend({ id: 'container', source: { type: 'external-runtime', connect: () => shell }, egress: { mode: 'none' } }),
				],
			});
			Reflect.set(project, 'computerInstance', computer);
			Reflect.set(project, 'getWorkspaceContainer', () => ({ setInactivityTimeout: async () => {} }));
			await project.writeFileContent('/source.txt', 'baseline');
			const id = crypto.randomUUID();
			state.storage.kv.put(`computer-execution:${id}`, { status: 'running', sessionId: 'session', backend: 'container' });
			const attach = vi.spyOn(shell, 'getExec').mockImplementation(async () => ({
				id,
				events: new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								`${JSON.stringify({ id, seq: 1, name: 'stdout', value: 'reconnected' })}\n${JSON.stringify({ id, seq: 2, name: 'exit', value: 0 })}\n`,
							),
						);
						controller.close();
					},
				}),
			}));
			const execute = vi.spyOn(shell, 'exec');
			const pull = vi.spyOn(computer, 'pull').mockImplementation(async function* () {
				/* Already synchronized. */
			});
			const result = await project.computerExec('must not replay', { id, backend: 'shell' }, 'session');
			expect(attach).toHaveBeenCalledWith(expect.objectContaining({ id, after: undefined }));
			expect(execute).not.toHaveBeenCalled();
			expect(result).toMatchObject({ backend: 'container', stdout: 'reconnected', status: 'completed', syncStatus: 'complete' });
			pull.mockRestore();
			await computer.close();
		});
	});
});
