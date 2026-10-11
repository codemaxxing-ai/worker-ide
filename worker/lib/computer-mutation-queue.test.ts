import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { ComputerMutationQueue, ComputerSynchronizationPending } from './computer-mutation-queue';

describe('Computer mutation ownership', () => {
	it('holds competing session and editor writes until execution synchronization finishes', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (_instance, state) => {
			const queue = new ComputerMutationQueue(state.storage, async () => {});
			const events: string[] = [];
			let release: (() => void) | undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const execution = queue.run('computerExec', [], async () => {
				events.push('command');
				await queue.run('internal-write', [], async () => {
					events.push('runtime-write');
				});
				await gate;
				events.push('synchronized');
			});
			const session = queue.run('wsWriteFile', [], async () => {
				events.push('session');
			});
			const editor = queue.run('writeFileContent', [], async () => {
				events.push('editor');
			});
			await Promise.resolve();
			expect(events).not.toContain('session');
			release?.();
			await Promise.all([execution, session, editor]);
			expect(events).toEqual(['command', 'runtime-write', 'synchronized', 'session', 'editor']);
		});
	});

	it('keeps failed synchronization ahead of queued writes and recovers without replaying a command', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (_instance, state) => {
			let commands = 0;
			const first = new ComputerMutationQueue(state.storage, async () => {});
			await expect(
				first.run('computerExec', ['saved-id'], async () => {
					commands++;
					throw new ComputerSynchronizationPending('pull failed');
				}),
			).rejects.toThrow('pull failed');
			await first.resume();
			// Model a restart: the durable command outcome is saved; recovery only pulls.
			state.storage.sql.exec("UPDATE computer_mutation_queue SET status = 'sync-pending' WHERE sequence = 1");
			state.storage.sql.exec("INSERT INTO computer_mutation_queue (operation, arguments) VALUES ('editor', '[]')");
			const recovered: string[] = [];
			const second = new ComputerMutationQueue(state.storage, async (operation) => {
				recovered.push(operation === 'computerExec' ? 'pull' : operation);
			});
			await second.resume();
			expect(commands).toBe(1);
			expect(recovered).toEqual(['pull', 'editor']);
		});
	});

	it('reports an interrupted mutation with uncertain outcome instead of replaying it', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (_instance, state) => {
			const queue = new ComputerMutationQueue(state.storage, async () => {
				throw new Error('must not replay');
			});
			state.storage.sql.exec("INSERT INTO computer_mutation_queue (operation, arguments, status) VALUES ('gitCommit', '[]', 'running')");
			await queue.resume();
			expect(
				state.storage.sql.exec<{ status: string; error: string }>('SELECT status, error FROM computer_mutation_queue').one(),
			).toMatchObject({ status: 'failed', error: expect.stringContaining('uncertain outcome') });
		});
	});
	it('registers an awaiting caller before yielding to the alarm write', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (_instance, state) => {
			const recover = vi.fn(async () => {});
			const queue = new ComputerMutationQueue(state.storage, recover);
			let started: (() => void) | undefined;
			let release: (() => void) | undefined;
			const ready = new Promise<void>((resolve) => {
				started = resolve;
			});
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const first = queue.run('computerExec', [], async () => {
				started?.();
				await gate;
			});
			await ready;
			let alarmReady: (() => void) | undefined;
			const alarmGate = new Promise<void>((resolve) => {
				alarmReady = resolve;
			});
			const alarm = vi.spyOn(state.storage, 'setAlarm').mockImplementationOnce(async () => {
				await alarmGate;
			});
			const second = queue.run('editor', [], async () => 42);
			release?.();
			await first;
			await queue.resume();
			alarmReady?.();
			expect(await second).toBe(42);
			expect(recover).not.toHaveBeenCalled();
			alarm.mockRestore();
		});
	});

	it('recovers a large queued payload after a restart and reports missing chunks', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (_instance, state) => {
			const recovered = vi.fn(async (_operation: string, _argumentsJson: string) => {});
			const queue = new ComputerMutationQueue(state.storage, recovered);
			const argumentsJson = JSON.stringify(['/large.txt', 'durable text\n'.repeat(200_000)]);
			const count = Math.ceil(argumentsJson.length / 128_000);
			for (const sequence of [1, 2]) {
				state.storage.sql.exec(
					'INSERT INTO computer_mutation_queue (sequence, operation, arguments) VALUES (?, ?, ?)',
					sequence,
					'wsWriteFile',
					`@payload:${count}`,
				);
				for (let part = 0; part < count; part++) {
					if (sequence === 2 && part === count - 1) continue;
					state.storage.sql.exec(
						'INSERT INTO computer_mutation_payload (sequence, part, content) VALUES (?, ?, ?)',
						sequence,
						part,
						argumentsJson.slice(part * 128_000, (part + 1) * 128_000),
					);
				}
			}
			await queue.resume();
			expect(recovered).toHaveBeenCalledExactlyOnceWith('wsWriteFile', argumentsJson);
			expect(state.storage.sql.exec('SELECT 1 FROM computer_mutation_payload WHERE sequence = 1').toArray()).toEqual([]);
			expect(
				state.storage.sql
					.exec<{ status: string; error: string }>('SELECT status, error FROM computer_mutation_queue WHERE sequence = 2')
					.one(),
			).toMatchObject({ status: 'failed', error: 'Missing queued mutation payload: 2' });
		});
	});
});
