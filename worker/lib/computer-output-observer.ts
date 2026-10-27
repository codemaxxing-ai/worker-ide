import { RpcTarget } from 'cloudflare:workers';

import { truncateOutput } from '@shared/command-output';

import type { CommandOutput } from '@shared/command-output';

/** Ephemeral capability. Never include this target in durable mutation arguments. */
export class ComputerOutputObserver extends RpcTarget {
	constructor(private readonly receive: (output: CommandOutput) => Promise<void>) {
		super();
	}
	onOutput(output: CommandOutput): Promise<void> {
		return this.receive(output);
	}
}

/** One in-flight RPC and one replacement snapshot; slow observers cannot block execution. */
export class ComputerOutputPublisher {
	private pending?: CommandOutput;
	private latest?: CommandOutput;
	private timer?: ReturnType<typeof setTimeout>;
	private sending = false;
	private disabled = false;
	constructor(
		private observer: ComputerOutputObserver | undefined,
		private waitUntil: (promise: Promise<void>) => void,
	) {}

	publish(output: CommandOutput): void {
		if (!this.observer || this.disabled) return;
		const stdout = truncateOutput(output.stdout, 60_000);
		const stderr = truncateOutput(output.stderr, 60_000);
		output = { ...output, stdout, stderr, truncated: output.truncated || stdout !== output.stdout || stderr !== output.stderr };
		const latest = this.latest;
		if (output.final && latest)
			output = {
				...output,
				stdoutBytes: Math.max(output.stdoutBytes, latest.stdoutBytes),
				stderrBytes: Math.max(output.stderrBytes, latest.stderrBytes),
				truncated: output.truncated || latest.truncated,
			};
		this.latest = output;
		this.pending = output;
		if (this.timer === undefined && !this.sending) this.timer = setTimeout(() => this.flush(), 100);
	}

	flush(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		if (this.disabled || this.sending || !this.pending || !this.observer) return;
		const output = this.pending;
		this.pending = undefined;
		this.sending = true;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const send = Promise.race([
			Promise.resolve().then(() => this.observer?.onOutput(output)),
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error('Output observer timed out')), 2000);
			}),
		])
			.then(
				() => {},
				() => {
					this.disabled = true;
					this.pending = undefined;
				},
			)
			.finally(() => {
				clearTimeout(timeout);
				this.sending = false;
				if (this.pending && !this.disabled) this.timer = setTimeout(() => this.flush(), 100);
			});
		this.waitUntil(send);
	}
}
