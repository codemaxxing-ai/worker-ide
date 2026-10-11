import { AsyncLocalStorage } from 'node:async_hooks';
import { Buffer } from 'node:buffer';

type MutationIntent = {
	sequence: number;
	operation: string;
	arguments: string;
	status: string;
};

interface MutationWaiter {
	execute: () => Promise<void>;
	complete: () => void;
	reject: (error: Error) => void;
}

/** An execution retains its FIFO position until its workspace is synchronized. */
export class ComputerSynchronizationPending extends Error {}

export class ComputerMutationQueue {
	private readonly scope = new AsyncLocalStorage<number>();
	private readonly waiters = new Map<number, MutationWaiter>();
	private processing?: Promise<void>;

	constructor(
		private readonly storage: DurableObjectStorage,
		private readonly recover: (operation: string, argumentsJson: string) => Promise<void>,
	) {
		storage.sql.exec(`CREATE TABLE IF NOT EXISTS computer_mutation_queue (
			sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation TEXT NOT NULL, arguments TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'queued', error TEXT)`);
		storage.sql.exec(
			'CREATE TABLE IF NOT EXISTS computer_mutation_payload (sequence INTEGER NOT NULL, part INTEGER NOT NULL, content TEXT NOT NULL, PRIMARY KEY (sequence, part))',
		);
	}

	async run<T>(operation: string, argumentsValue: unknown[], execute: () => Promise<T>): Promise<T> {
		if (this.scope.getStore() !== undefined) return execute();
		const argumentsJson = JSON.stringify(argumentsValue, (_key, value) =>
			value instanceof Uint8Array ? { computerBytes: Buffer.from(value).toString('base64') } : value,
		);
		const sequence = this.storage.transactionSync(() => {
			const identifier = this.storage.sql
				.exec<{ sequence: number }>(
					'INSERT INTO computer_mutation_queue (operation, arguments) VALUES (?, ?) RETURNING sequence',
					operation,
					argumentsJson.length > 128_000 ? `@payload:${Math.ceil(argumentsJson.length / 128_000)}` : argumentsJson,
				)
				.one().sequence;
			if (argumentsJson.length > 128_000) {
				for (let offset = 0; offset < argumentsJson.length; offset += 128_000)
					this.storage.sql.exec(
						'INSERT INTO computer_mutation_payload (sequence, part, content) VALUES (?, ?, ?)',
						identifier,
						offset / 128_000,
						argumentsJson.slice(offset, offset + 128_000),
					);
			}
			return identifier;
		});
		const result = new Promise<T>((resolve, reject) => {
			let outcome: T;
			this.waiters.set(sequence, {
				execute: async () => {
					outcome = await execute();
				},
				complete: () => resolve(outcome),
				reject,
			});
		});
		await this.storage.setAlarm(Date.now() + 1000);
		void this.resume();
		return result;
	}

	async resume(): Promise<void> {
		if (this.processing) return this.processing;
		this.processing = this.process().finally(() => {
			this.processing = undefined;
			// A new caller can enqueue while the previous drain deletes its alarm.
			// Recheck after releasing processing so that intent cannot be stranded.
			const head = this.storage.sql
				.exec<{ status: string }>(
					"SELECT status FROM computer_mutation_queue WHERE status IN ('queued', 'running', 'sync-pending') ORDER BY sequence LIMIT 1",
				)
				.toArray()[0];
			if (head?.status === 'queued') void this.resume();
		});
		return this.processing;
	}

	private argumentsFor(row: MutationIntent): string {
		if (!row.arguments.startsWith('@payload')) return row.arguments;
		const count = Number(row.arguments.split(':')[1]);
		const parts = this.storage.sql
			.exec<{ part: number; content: string }>(
				'SELECT part, content FROM computer_mutation_payload WHERE sequence = ? ORDER BY part',
				row.sequence,
			)
			.toArray();
		if (parts.length === 0 || (Number.isFinite(count) && parts.length !== count) || parts.some((part, index) => part.part !== index))
			throw new Error(`Missing queued mutation payload: ${row.sequence}`);
		return parts.map((part) => part.content).join('');
	}

	private async process(): Promise<void> {
		for (;;) {
			const row = this.storage.sql
				.exec<MutationIntent>(
					"SELECT sequence, operation, arguments, status FROM computer_mutation_queue WHERE status IN ('queued', 'running', 'sync-pending') ORDER BY sequence LIMIT 1",
				)
				.toArray()[0];
			if (!row) {
				await this.storage.deleteAlarm();
				return;
			}
			const waiter = this.waiters.get(row.sequence);
			await this.storage.setAlarm(Date.now() + 30_000);
			// Keep a recovery alarm armed even when a native command emits no output.
			const heartbeat = setInterval(() => {
				void this.storage.setAlarm(Date.now() + 30_000);
			}, 10_000);
			try {
				if (row.status === 'running' && row.operation !== 'computerExec') {
					throw new Error(`Interrupted ${row.operation} has an uncertain outcome; inspect the project before retrying.`);
				}
				this.storage.sql.exec("UPDATE computer_mutation_queue SET status = 'running' WHERE sequence = ?", row.sequence);
				await this.scope.run(row.sequence, async () => {
					await (waiter ? waiter.execute() : this.recover(row.operation, this.argumentsFor(row)));
				});
				this.storage.sql.exec("UPDATE computer_mutation_queue SET status = 'complete' WHERE sequence = ?", row.sequence);
				this.storage.sql.exec('DELETE FROM computer_mutation_payload WHERE sequence = ?', row.sequence);
				if (
					this.storage.sql
						.exec("SELECT 1 FROM computer_mutation_queue WHERE status IN ('queued', 'running', 'sync-pending') LIMIT 1")
						.toArray().length === 0
				)
					await this.storage.deleteAlarm();
				waiter?.complete();
			} catch (error) {
				const failure = error instanceof Error ? error : new Error(String(error));
				const pending = failure instanceof ComputerSynchronizationPending;
				this.storage.sql.exec(
					'UPDATE computer_mutation_queue SET status = ?, error = ? WHERE sequence = ?',
					pending ? 'sync-pending' : 'failed',
					failure.message,
					row.sequence,
				);
				waiter?.reject(failure);
				if (pending) return;
			} finally {
				clearInterval(heartbeat);
				this.waiters.delete(row.sequence);
			}
		}
	}
}
