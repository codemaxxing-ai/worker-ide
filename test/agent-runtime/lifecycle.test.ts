import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { build } from 'esbuild';
import { parse } from 'jsonc-parser';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { V4ModuleDefinition } from 'miniflare';

let runtime: Miniflare;

beforeAll(async () => {
	const bundleRoot = path.resolve('dist/worker_ide');
	const configuration = z
		.object({ compatibility_date: z.string(), compatibility_flags: z.array(z.string()) })
		.parse(parse(readFileSync('wrangler.jsonc', 'utf8')));
	const fixture = await build({
		entryPoints: ['test/agent-runtime/fixture.ts'],
		bundle: true,
		write: false,
		format: 'esm',
		platform: 'neutral',
		target: 'es2024',
		external: ['cloudflare:*', 'node:*'],
		plugins: [
			{
				name: 'production-agent-bundle',
				setup(buildContext) {
					buildContext.onResolve({ filter: /\/worker\/durable$/ }, () => ({ path: './index.js', external: true }));
				},
			},
		],
	});
	const fixtureCode = fixture.outputFiles[0]?.text;
	if (!fixtureCode) throw new Error('Missing compiled lifecycle fixture');
	const modules: V4ModuleDefinition[] = [
		{ type: 'ESModule', path: path.join(bundleRoot, 'lifecycle-fixture.js'), contents: fixtureCode },
		...globSync(`${bundleRoot}/**/*.js`)
			.filter((file) => !file.endsWith('-fixture.js'))
			.map<V4ModuleDefinition>((file) => ({ type: 'ESModule', path: file })),
	];
	runtime = new Miniflare(
		convertV4MiniflareOptions({
			name: 'agent-lifecycle',
			modules,
			modulesRoot: bundleRoot,
			compatibilityDate: configuration.compatibility_date,
			compatibilityFlags: configuration.compatibility_flags,
			durableObjects: {
				ProjectAgent: { className: 'ProjectAgent', useSQLite: true },
				DurableObjectFilesystem: { className: 'DurableObjectFilesystem', useSQLite: true },
				ProjectCoordinatorV2: { className: 'ProjectCoordinatorV2', useSQLite: true },
				ProjectMetadata: { className: 'ProjectMetadata', useSQLite: true },
			},
			d1Databases: ['DB'],
			workerLoaders: { LOADER: {} },
			serviceBindings: {
				AI: { name: 'agent-lifecycle', entrypoint: 'FixtureAI' },
				PUSH: { name: 'agent-lifecycle', entrypoint: 'FixturePush' },
			},
		}),
	);
	await runtime.ready;
	const database = await runtime.getD1Database('DB');
	await database.exec(
		`CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, image TEXT); INSERT INTO "user" VALUES ('original-author', 'Original author', NULL)`,
	);
});

afterAll(async () => {
	await runtime?.dispose();
});

async function request(pathname: string, projectId?: string, body?: unknown) {
	const url = new URL(pathname, 'http://agent-lifecycle');
	if (projectId) url.searchParams.set('project', projectId);
	const response = await runtime.dispatchFetch(url.toString(), {
		method: body === undefined ? 'GET' : 'POST',
		body: body === undefined ? undefined : JSON.stringify(body),
		headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
	});
	if (!response.ok) throw new Error(`${pathname}: ${await response.text()}`);
	return response.json();
}

async function createProject() {
	return z.object({ projectId: z.string() }).parse(await request('/project')).projectId;
}

async function connectChat(projectId: string, sessionId = 'session') {
	const response = await runtime.dispatchFetch(`http://agent-lifecycle/chat?project=${projectId}&session=${sessionId}`, {
		headers: { Upgrade: 'websocket' },
	});
	if (!response.webSocket) throw new Error(`Chat connection rejected: ${response.status}`);
	const socket = response.webSocket;
	const frames: unknown[] = [];
	socket.addEventListener('message', (event) => {
		if (typeof event.data !== 'string') return;
		const frame: unknown = JSON.parse(event.data);
		frames.push(frame);
		const resuming = z.object({ type: z.literal('cf_agent_stream_resuming'), id: z.string() }).safeParse(frame);
		if (resuming.success) socket.send(JSON.stringify({ type: 'cf_agent_stream_resume_ack', id: resuming.data.id }));
	});
	socket.accept();
	return { socket, frames };
}

async function waitForStatus(projectId: string, status: 'completed' | 'error' | 'aborted', timeout = 4000) {
	const terminal = await vi.waitFor(
		async () => {
			const state = z
				.object({ status: z.string(), stopRequested: z.boolean() })
				.passthrough()
				.parse(await request('/state', projectId));
			expect(state.status).not.toBe('running');
			expect(state.stopRequested).toBe(false);
			return state;
		},
		{ timeout, interval: 25 },
	);
	expect(terminal).toMatchObject({ status, stopRequested: false });
}

async function waitForToolInput(projectId: string) {
	await vi.waitFor(
		async () => {
			expect(await request('/state', projectId)).toMatchObject({ status: 'running', hasToolInput: true });
		},
		{ timeout: 8000 },
	);
}

describe('production agent lifecycle in the current Workers runtime', () => {
	it('streams a server-admitted turn directly to two native clients and resumes observation after reconnect', async () => {
		const projectId = await createProject();
		await request('/seed-history', projectId);
		const first = await connectChat(projectId);
		const second = await connectChat(projectId);
		try {
			await request('/submit', projectId, { messageId: 'streamed', prompt: 'codemode-output' });
			await vi.waitFor(
				() => {
					expect(JSON.stringify(first.frames)).toContain('first');
					expect(JSON.stringify(second.frames)).toContain('first');
				},
				{ timeout: 5000 },
			);
			first.socket.close();
			const reconnected = await connectChat(projectId);
			try {
				await waitForStatus(projectId, 'completed', 6000);
				await vi.waitFor(() => expect(JSON.stringify(reconnected.frames)).toContain('Session completed'));
				expect(JSON.stringify(second.frames)).toContain('Session completed');
			} finally {
				reconnected.socket.close();
			}
		} finally {
			if (first.socket.readyState === 1) first.socket.close();
			if (second.socket.readyState === 1) second.socket.close();
		}
	});
	it('uses stored content and author metadata for native regeneration and preserves the original answer branch', async () => {
		const projectId = await createProject();
		await request('/seed-history', projectId);
		await request('/fail-notifications');
		const client = await connectChat(projectId);
		try {
			client.socket.send(
				JSON.stringify({
					type: 'cf_agent_use_chat_request',
					id: 'native-regeneration',
					init: {
						method: 'POST',
						body: JSON.stringify({
							trigger: 'regenerate-message',
							messages: [
								{
									id: 'old-user',
									role: 'user',
									metadata: { authorUserId: 'forged-author' },
									parts: [{ type: 'text', text: 'forged content' }],
								},
							],
						}),
					},
				}),
			);
			await vi.waitFor(async () => expect(JSON.stringify(await request('/session', projectId))).toContain('native-regeneration'), {
				timeout: 5000,
			});
			await waitForStatus(projectId, 'completed');
			const session = JSON.stringify(await request('/session', projectId));
			expect(session).toContain('original-author');
			expect(session).not.toContain('forged-author');
			expect(session).not.toContain('forged content');
			expect(await request('/branches', projectId)).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'old-assistant' })]));
			expect(await request('/state', projectId)).toMatchObject({ finalizing: true });
			await request('/enable-notifications');
			await request('/restore-completion', projectId);
			await request('/restore-completion', projectId);
			expect(await request('/state', projectId)).toMatchObject({ finalizing: false, finalizations: {} });
			const notifications = z.array(z.object({ userId: z.string(), tag: z.string().optional() })).parse(await request('/notifications'));
			expect(notifications.filter((item) => item.tag === 'session:native-regeneration')).toEqual([
				{ userId: 'original-author', tag: 'session:native-regeneration' },
			]);
		} finally {
			await request('/enable-notifications');
			client.socket.close();
		}
	});
	it.each(['missing', 'deleted'])('rejects %s child sessions before routing a WebSocket', async (sessionId) => {
		const projectId = await createProject();
		if (sessionId === 'deleted') {
			await request('/submit?session=deleted', projectId, { messageId: 'hello', prompt: 'hello' });
			await request('/delete?session=deleted', projectId);
		}
		const response = await runtime.dispatchFetch(`http://agent-lifecycle/chat?project=${projectId}&session=${sessionId}`, {
			headers: { Upgrade: 'websocket' },
		});
		// Agents turns a rejected upgrade into a policy close to stop automatic reconnects.
		expect(response.status).toBe(101);
		const socket = response.webSocket;
		if (!socket) throw new Error('Missing rejection socket');
		const closed = Promise.withResolvers<number>();
		socket.addEventListener('close', (event) => closed.resolve(event.code));
		socket.accept();
		expect(await closed.promise).toBe(4404);
	});
	it('keeps admissions closed after failed deletion until finalization is delivered and deletion retried', async () => {
		const projectId = await createProject();
		await request('/block-completion', projectId);
		await request('/submit', projectId, { messageId: 'message', prompt: 'hello' });
		await waitForStatus(projectId, 'completed');
		const client = await connectChat(projectId);
		try {
			await expect(request('/delete', projectId)).rejects.toThrow('Simulated exhausted completion RPC');
			await expect(request('/submit', projectId, { messageId: 'late', prompt: 'hello' })).rejects.toThrow('being deleted');
			const closed = Promise.withResolvers<number>();
			client.socket.addEventListener('close', (event) => closed.resolve(event.code));
			client.socket.send(
				JSON.stringify({
					type: 'cf_agent_use_chat_request',
					id: 'late-native',
					init: { method: 'POST', body: JSON.stringify({ trigger: 'regenerate-message', messages: [{ id: 'message' }] }) },
				}),
			);
			expect(await closed.promise).toBe(1008);
			const rejected = await connectChat(projectId);
			const rejectedClose = Promise.withResolvers<number>();
			rejected.socket.addEventListener('close', (event) => rejectedClose.resolve(event.code));
			expect(await rejectedClose.promise).toBe(4404);
			await request('/restore-completion', projectId);
			await expect(request('/delete', projectId)).resolves.toEqual({ deleted: true });
			await expect(request('/submit', projectId, { messageId: 'resurrected', prompt: 'hello' })).rejects.toThrow('being deleted');
		} finally {
			if (client.socket.readyState === 1) client.socket.close();
		}
	});
	it('starts native regeneration with fresh failure, tool and debug-log state after a guard stop', async () => {
		const projectId = await createProject();
		await request('/submit', projectId, { messageId: 'message', prompt: 'repeat-failure' });
		await waitForStatus(projectId, 'error');
		const previous = z
			.object({ chunks: z.number(), activeDebugLog: z.object({ id: z.string() }) })
			.parse(await request('/state', projectId));
		const client = await connectChat(projectId);
		try {
			client.socket.send(
				JSON.stringify({
					type: 'cf_agent_use_chat_request',
					id: 'retry-after-guard',
					init: { method: 'POST', body: JSON.stringify({ trigger: 'regenerate-message', messages: [{ id: 'message' }] }) },
				}),
			);
			await vi.waitFor(
				async () => {
					expect(await request('/state', projectId)).toMatchObject({ failureState: { submissionId: 'retry-after-guard', count: 3 } });
				},
				{ timeout: 5000 },
			);
			await waitForStatus(projectId, 'error');
			const retried = z
				.object({ chunks: z.number(), activeDebugLog: z.object({ id: z.string() }) })
				.parse(await request('/state', projectId));
			expect(retried.chunks).toBeGreaterThan(previous.chunks);
			expect(retried.activeDebugLog.id).not.toBe(previous.activeDebugLog.id);
		} finally {
			client.socket.close();
		}
	});
	it.each(['{', JSON.stringify({ trigger: 'submit-message', messages: [] })])(
		'rejects malformed or unadmitted native requests (%s)',
		async (body) => {
			const projectId = await createProject();
			await request('/seed-history', projectId);
			const { socket } = await connectChat(projectId);
			const closed = Promise.withResolvers<number>();
			socket.addEventListener('close', (event) => closed.resolve(event.code));
			socket.send(JSON.stringify({ type: 'cf_agent_use_chat_request', id: 'invalid', init: { method: 'POST', body } }));
			expect(await closed.promise).toBe(1008);
		},
	);
	it('forwards delegated command output through native retained-run progress', async () => {
		const projectId = await createProject();
		await request('/submit', projectId, { messageId: 'message', prompt: 'delegate-output' });
		await vi.waitFor(
			async () => {
				expect(await request('/state', projectId)).toMatchObject({
					status: 'running',
					taskProgress: { data: { commandOutput: { executions: expect.arrayContaining([expect.objectContaining({ stdout: 'first' })]) } } },
				});
			},
			{ timeout: 6000, interval: 25 },
		);
		await vi.waitFor(
			async () => {
				expect(await request('/state', projectId)).toMatchObject({
					taskProgress: {
						data: { commandOutput: { executions: expect.arrayContaining([expect.objectContaining({ stdout: 'second' })]) } },
					},
				});
			},
			{ timeout: 6000, interval: 25 },
		);
		await waitForStatus(projectId, 'completed', 6000);
		expect(JSON.stringify(await request('/session', projectId))).toContain('second');
	});
	it('streams multiple CodeMode command records before the outer tool completes', async () => {
		const projectId = await createProject();
		await request('/submit', projectId, { messageId: 'message', prompt: 'codemode-output' });
		await vi.waitFor(
			async () => {
				expect(await request('/state', projectId)).toMatchObject({
					status: 'running',
					toolMetadata: { 'codemode-call': { commandOutput: { executions: [expect.objectContaining({ stdout: 'first' })] } } },
				});
			},
			{ timeout: 4000, interval: 25 },
		);
		await vi.waitFor(
			async () => {
				expect(await request('/state', projectId)).toMatchObject({
					status: 'running',
					toolMetadata: {
						'codemode-call': {
							commandOutput: { executions: [expect.objectContaining({ stdout: 'first' }), expect.objectContaining({ stdout: 'second' })] },
						},
					},
				});
			},
			{ timeout: 4000, interval: 25 },
		);
		await waitForStatus(projectId, 'completed');
		expect(JSON.stringify(await request('/session', projectId))).toContain('second');
	});
	it.each(['repeat-failure', 'codemode-failure', 'state-failure'])(
		'stops equivalent structured failures and permits a new submission (%s)',
		async (prompt) => {
			const projectId = await createProject();
			await request('/submit', projectId, { messageId: 'message', prompt });
			await waitForStatus(projectId, 'error');
			expect(await request('/state', projectId)).toMatchObject({
				error: expect.stringContaining('three repeated failures'),
			});
			expect(await request('/file', projectId)).toEqual({ content: 'baseline' });
			await request('/submit', projectId, { messageId: 'recovered', prompt: 'hello' });
			await waitForStatus(projectId, 'completed');
		},
	);
	it('resets repeated CodeMode failures after successful state operations', async () => {
		const projectId = await createProject();
		await request('/submit', projectId, { messageId: 'message', prompt: 'codemode-progress' });
		await waitForStatus(projectId, 'completed');
		expect(await request('/file', projectId)).toEqual({ content: 'progress-2' });
		expect(await request('/state', projectId)).not.toHaveProperty('doomLoopMessage', expect.any(String));
	});
	it.each(['hello', 'fail'])('saves a downloadable debug log and restores its ID after reopening (%s)', async (prompt) => {
		const projectId = await createProject();
		await request('/submit', projectId, { messageId: 'message', prompt });
		await waitForStatus(projectId, prompt === 'fail' ? 'error' : 'completed');
		const debugLogId = await vi.waitFor(
			async () => {
				return z.object({ debugLogId: z.string().min(1) }).parse(await request('/state', projectId)).debugLogId;
			},
			{ timeout: 4000 },
		);
		expect(await request('/debug-log', projectId)).toMatchObject({
			id: debugLogId,
			sessionId: 'session',
			projectId,
			mode: 'code',
			entries: expect.arrayContaining([expect.objectContaining({ category: 'agent_loop', event: 'finished' })]),
		});
		expect(await request('/reload-session', projectId)).toMatchObject({ debugLogId });
	});

	it('reconciles a completed child from a fresh invocation when its completion RPC failed', async () => {
		const projectId = await createProject();
		await request('/block-completion', projectId);
		await request('/submit', projectId, { messageId: 'message', prompt: 'hello' });
		await vi.waitFor(
			async () => {
				expect(await request('/submission', projectId)).toMatchObject({ status: 'completed' });
			},
			{ timeout: 4000 },
		);
		expect(await request('/state', projectId)).toMatchObject({ status: 'completed', finalizations: expect.any(Object) });
		await request('/restore-completion', projectId);
		await waitForStatus(projectId, 'completed');
		expect(await request('/session', projectId)).toMatchObject({ status: 'completed' });
	});

	it('handles a TODO update and 16,000 edit argument chunks without exhausting the RPC budget', async () => {
		const projectId = await createProject();
		await request('/submit', projectId, { messageId: 'message', prompt: 'burst-edit' });
		// This exercises request volume, not runner throughput. Keep the strict
		// RPC assertions below while allowing slower CI CPUs to consume the burst.
		await waitForStatus(projectId, 'completed', 20_000);
		expect(await request('/file', projectId)).toEqual({ content: 'x'.repeat(16_000) });
		const traffic = z.object({ summaryUpdates: z.number() }).parse(await request('/traffic', projectId));
		expect(traffic.summaryUpdates).toBeLessThan(100);
	}, 30_000);

	it('writes a file through the provider, scheduled Think facet, and Computer tools', async () => {
		const projectId = await createProject();
		expect(await request('/submit', projectId, { messageId: 'message', prompt: 'write' })).toMatchObject({ accepted: true });
		await waitForStatus(projectId, 'completed');
		expect(await request('/file', projectId)).toEqual({ content: 'saved by agent' });
		expect(await request('/session', projectId)).toMatchObject({
			status: 'completed',
			history: expect.arrayContaining([
				expect.objectContaining({
					role: 'assistant',
					parts: expect.arrayContaining([expect.objectContaining({ state: 'output-available' })]),
				}),
			]),
		});
	});

	it('recovers after an interrupted turn without replaying the unfinished write', async () => {
		const projectId = await createProject();
		await request('/submit', projectId, { messageId: 'message', prompt: 'stall' });
		await waitForToolInput(projectId);
		await expect(request('/evict', projectId)).rejects.toThrow('Simulated session eviction');
		await request('/stop', projectId);
		await waitForStatus(projectId, 'aborted');
		expect(await request('/file', projectId)).toEqual({ content: 'baseline' });
		await request('/submit', projectId, { messageId: 'next', prompt: 'hello' });
		await waitForStatus(projectId, 'completed');
		expect(await request('/session', projectId)).not.toHaveProperty('error');
	});

	it('stops an unfinished tool argument stream and completes a new turn without a stale error', async () => {
		const projectId = await createProject();
		await request('/submit', projectId, { messageId: 'message', prompt: 'stall' });
		await waitForToolInput(projectId);
		expect(await request('/submit', projectId, { messageId: 'queued', prompt: 'hello' })).toMatchObject({ status: 'pending' });
		await request('/stop', projectId);
		expect(await request('/submission', projectId)).toMatchObject({ status: 'aborted' });
		expect(await request('/submission?message=queued', projectId)).toMatchObject({ status: 'aborted' });
		await waitForStatus(projectId, 'aborted');
		await request('/submit', projectId, { messageId: 'next', prompt: 'write' });
		await waitForStatus(projectId, 'completed');
		expect(await request('/session', projectId)).not.toHaveProperty('error');
	});

	it('clears a failed turn error after a successful retry and reload', async () => {
		const projectId = await createProject();
		await request('/submit', projectId, { messageId: 'message', prompt: 'fail' });
		await waitForStatus(projectId, 'error');
		await request('/submit', projectId, { messageId: 'next', prompt: 'hello' });
		await waitForStatus(projectId, 'completed');
		expect(await request('/session', projectId)).not.toHaveProperty('error');
	});

	it('starts a new turn after stopping a provider request that has not returned a stream', async () => {
		const projectId = await createProject();
		await request('/submit', projectId, { messageId: 'message', prompt: 'stall-start' });
		await vi.waitFor(
			async () => {
				expect(await request('/provider-started?prompt=stall-start')).toEqual({ started: true });
			},
			{ timeout: 3000 },
		);
		await request('/stop', projectId);
		await waitForStatus(projectId, 'aborted');
		await request('/submit', projectId, { messageId: 'next', prompt: 'hello' });
		await waitForStatus(projectId, 'completed');
	});

	it('preserves existing conversation history when its Think facet is first created', async () => {
		const projectId = await createProject();
		await request('/seed-history', projectId);
		await request('/submit', projectId, { messageId: 'next', prompt: 'recall' });
		await waitForStatus(projectId, 'completed');
		expect(await request('/session', projectId)).toMatchObject({
			history: expect.arrayContaining([
				expect.objectContaining({
					id: 'old-user',
					metadata: expect.objectContaining({ authorUserId: 'original-author', createdAt: 123_000, snapshotId: 'original-review' }),
				}),
				expect.objectContaining({ id: 'old-assistant', parts: [{ type: 'text', text: 'Previous answer'.repeat(1000) }] }),
				expect.objectContaining({ id: 'next' }),
				expect.objectContaining({
					role: 'assistant',
					parts: expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'Earlier request retained' })]),
				}),
			]),
		});
	});

	it('deduplicates a retried admission without copying the transcript into the directory', async () => {
		const projectId = await createProject();
		await request('/submit', projectId, { messageId: 'same', prompt: 'hello' });
		await waitForStatus(projectId, 'completed');
		expect(await request('/submit', projectId, { messageId: 'same', prompt: 'hello' })).toMatchObject({ accepted: false });
		const session = z.object({ history: z.array(z.object({ id: z.string() })) }).parse(await request('/session', projectId));
		expect(session.history.filter((message) => message.id === 'same')).toHaveLength(1);
	});
});
