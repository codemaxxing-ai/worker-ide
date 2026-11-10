import { AsyncLocalStorage } from 'node:async_hooks';

import { createAITools } from '@cloudflare/computer/tools/ai-sdk';
import { z } from 'zod';

import { ComputerOutputObserver } from '../../../lib/computer-output-observer';
import { computerPath, projectPath } from '../../../lib/computer-workspace';

import type { ToolExecutorContext } from '../types';
import type { WorkspaceRuntimeExecOptions } from '@cloudflare/computer';
import type { WorkspaceLike } from '@cloudflare/computer/tools';

export function createComputerTools(context: ToolExecutorContext, mode: 'code' | 'plan' | 'ask') {
	const client = context.fsStub;
	const executionContext = new AsyncLocalStorage<ToolExecutorContext>();
	const writerId = context.sessionId ?? `agent:${context.projectId}`;
	const filesystem: WorkspaceLike['fs'] = {
		stat: async (path) => {
			using info = await client.wsStat(projectPath(computerPath(path)));
			if (!info) throw new Error(`ENOENT: ${path}`);
			return {
				size: info.size,
				mtime: info.updatedAt,
				mode: info.mode ?? (info.type === 'directory' ? 0o4_0755 : 0o10_0644),
				isFile: info.type === 'file',
				isDirectory: info.type === 'directory',
			};
		},
		readFile: (path, options) => client.computerReadFile(path, options),
		writeFile: (path, bytes) => client.wsWriteFileBytes(projectPath(computerPath(path)), bytes, context.sessionId),
		mkdir: (path, options) => client.wsMkdir(projectPath(computerPath(path)), options?.recursive ?? false, context.sessionId),
		rm: (path, options) =>
			client.wsRm(projectPath(computerPath(path)), options?.recursive ?? false, options?.force ?? false, context.sessionId),
		find: async (path, pattern, options) => {
			using entries = await client.computerFind(path, pattern, options);
			return entries.map((entry) => ({ ...entry }));
		},
		grep: async (pattern, path, options) => {
			using matches = await client.computerGrep(pattern, path, options);
			return matches.map((match) => ({ ...match }));
		},
		readdir: async (path, options) => {
			using entries = await client.wsReadDir(projectPath(computerPath(path)));
			return entries.slice(options?.offset ?? 0, (options?.offset ?? 0) + (options?.limit ?? entries.length)).map((entry) => ({
				name: entry.name,
				size: entry.size,
				mtime: entry.updatedAt,
				isFile: entry.type === 'file',
				isDirectory: entry.type === 'directory',
				isSymbolicLink: entry.type === 'symlink',
			}));
		},
	};
	const tools = createAITools({
		workspace: {
			fs: filesystem,
			runtime: {
				backends: () => ['auto', 'shell', 'container'].map((id) => ({ id, protocol: 'command', callable: false })),
				exec: async (command, options) => {
					const identifier = crypto.randomUUID();
					const result = executeComputerCommand(executionContext.getStore() ?? context, command, { ...options, id: identifier });
					return { result: () => result, kill: () => client.cancelComputerExecution(identifier, writerId) };
				},
			},
		},
		readonly: mode !== 'code',
		assets: false,
		execOutput: { maxBytes: 60_000, maxLines: 2000 },
		exec: {
			auto: {
				description:
					'Prefer this backend. Supported file/text commands stay in the Worker isolate; native binaries and full test runners use Linux. Use Worker lint, test, preview and browser tools when sufficient. Reuse installed dependencies for native checks. Commands are never retried on another backend.',
			},
			shell: {
				description: 'Isolate shell for file operations and text processing. No direct networking or native binaries. Deadline 30 seconds.',
			},
			container: {
				description:
					'Linux with Node 24, Bun, Git, Python and native build tools. Use only for a concrete native requirement, such as full TypeScript checking, DOM/Vitest tests or native binaries. Worker lint, lightweight tests and Worker previews/builds need no container installation. Check existing package availability; install only dependencies missing from the required native runtime. Source/type errors do not justify installing. Public HTTP(S) through the controlled gateway. Foreground commands only; deadline five minutes.',
			},
		},
	});
	if (tools.exec)
		tools.exec.inputSchema = z.object({
			command: z.string(),
			cwd: z.string().optional(),
			backend: z.enum(['auto', 'shell', 'container']).default('auto'),
			env: z.record(z.string(), z.string()).optional(),
			input: z.record(z.string(), z.json()).optional(),
		});
	for (const name of ['write', 'edit', 'delete']) {
		const definition = tools[name];
		if (!definition) continue;
		definition.execute = (input) => {
			if (name !== 'write' && name !== 'edit' && name !== 'delete') throw new Error('Invalid Computer mutation');
			return client.computerApplyTool(name, input, writerId);
		};
	}
	// Code Mode expects a single resolved result. Computer exec uses an async
	// generator, so consume it before draining changes or returning to the agent.
	for (const definition of Object.values(tools)) {
		const execute = definition.execute;
		if (typeof execute !== 'function') continue;
		definition.execute = async (input, options) => {
			const callOptions = options ?? {
				toolCallId: context.activeCodeMode?.toolCallId ?? crypto.randomUUID(),
				messages: [],
				abortSignal: context.activeCodeMode?.abortSignal ?? context.abortSignal,
			};
			return executionContext.run({ ...context, toolCallId: callOptions.toolCallId, abortSignal: callOptions.abortSignal }, async () => {
				const result: unknown = await execute(input, callOptions);
				if (!isAsyncResult(result)) return result;
				let final: unknown;
				for await (const output of result) final = output;
				return final;
			});
		};
	}
	return tools;
}

function isAsyncResult(value: unknown): value is AsyncIterable<unknown> {
	return Boolean(value && typeof value === 'object' && Symbol.asyncIterator in value);
}

export async function executeComputerCommand(
	context: ToolExecutorContext,
	command: string,
	options: WorkspaceRuntimeExecOptions<'utf8'> = {},
) {
	const identifier = options.id ?? crypto.randomUUID();
	const writerId = context.sessionId ?? `agent:${context.projectId}`;
	const cancel = () => {
		void context.fsStub.cancelComputerExecution(identifier, writerId).catch(() => {});
	};
	context.abortSignal?.throwIfAborted();
	context.abortSignal?.addEventListener('abort', cancel, { once: true });
	try {
		const observer =
			context.onToolOutput && context.toolCallId && context.submissionId
				? new ComputerOutputObserver(
						(output) =>
							context.onToolOutput?.({
								type: 'tool-output',
								submissionId: context.submissionId ?? '',
								toolCallId: context.toolCallId ?? '',
								toolName: context.activeCodeMode ? 'codemode' : (context.toolName ?? 'exec'),
								output,
							}) ?? Promise.resolve(),
					)
				: undefined;
		using result = await context.fsStub.computerExec(
			command,
			{
				id: identifier,
				backend: options.backend,
				cwd: options.cwd,
				env: options.env,
				inputJson: options.input === undefined ? undefined : JSON.stringify(options.input),
			},
			writerId,
			observer,
		);
		return { ...result };
	} finally {
		context.abortSignal?.removeEventListener('abort', cancel);
	}
}
