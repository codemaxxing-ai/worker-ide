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
				AgentRunner: { className: 'AgentRunner', useSQLite: true },
				DurableObjectFilesystem: { className: 'DurableObjectFilesystem', useSQLite: true },
				ProjectCoordinatorV2: { className: 'ProjectCoordinatorV2', useSQLite: true },
				ProjectMetadata: { className: 'ProjectMetadata', useSQLite: true },
			},
			d1Databases: ['DB'],
			workerLoaders: { LOADER: {} },
			serviceBindings: { AI: { name: 'agent-lifecycle', entrypoint: 'FixtureAI' } },
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
			expect(await request('/state', projectId)).toMatchObject({
				status: 'running',
				messages: expect.arrayContaining([
					expect.objectContaining({
						role: 'assistant',
						parts: expect.arrayContaining([expect.objectContaining({ type: 'tool-call', toolName: 'write' })]),
					}),
				]),
			});
		},
		{ timeout: 4000, interval: 25 },
	);
}

describe('production agent lifecycle in the current Workers runtime', () => {
	it('forwards subagent command output during execution and replaces it with the child result', async () => {
		const projectId = await createProject();
		await request('/submit', projectId, { messageId: 'message', prompt: 'delegate-output' });
		await vi.waitFor(
			async () => {
				expect(await request('/state', projectId)).toMatchObject({
					status: 'running',
					subAgentActivities: {
						delegate: {
							tools: expect.arrayContaining([
								expect.objectContaining({
									toolCallId: 'codemode-call',
									commandOutput: expect.objectContaining({
										executions: expect.arrayContaining([expect.objectContaining({ stdout: 'first' })]),
									}),
								}),
							]),
						},
					},
				});
			},
			{ timeout: 4000, interval: 25 },
		);
		await vi.waitFor(
			async () => {
				expect(await request('/state', projectId)).toMatchObject({
					status: 'running',
					subAgentActivities: {
						delegate: {
							tools: expect.arrayContaining([
								expect.objectContaining({ toolCallId: 'codemode-call', result: expect.stringContaining('second') }),
							]),
						},
					},
				});
			},
			{ timeout: 4000, interval: 25 },
		);
		await waitForStatus(projectId, 'completed');
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
				error: { message: expect.stringContaining('three repeated failures') },
				doomLoopMessage: expect.stringContaining('three repeated failures'),
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
		expect(await request('/state', projectId)).toMatchObject({ status: 'running' });
		expect(await request('/recovery-watch', projectId)).toEqual({ scheduled: true });
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
		const traffic = z.object({ streamBatches: z.number(), protocolBroadcasts: z.number() }).parse(await request('/traffic', projectId));
		expect(traffic.streamBatches).toBeLessThan(100);
		expect(traffic.protocolBroadcasts).toBe(0);
	}, 30_000);

	it('writes a file through the provider, scheduled Think facet, and Computer tools', async () => {
		const projectId = await createProject();
		expect(await request('/submit', projectId, { messageId: 'message', prompt: 'write' })).toMatchObject({ started: true });
		await waitForStatus(projectId, 'completed');
		expect(await request('/file', projectId)).toEqual({ content: 'saved by agent' });
		expect(await request('/session', projectId)).toMatchObject({
			status: 'completed',
			history: expect.arrayContaining([
				expect.objectContaining({
					role: 'assistant',
					parts: expect.arrayContaining([expect.objectContaining({ type: 'tool-result', toolName: 'write', isError: false })]),
				}),
			]),
		});
	});

	it('recovers after an interrupted turn without replaying the unfinished write', async () => {
		const projectId = await createProject();
		await request('/submit', projectId, { messageId: 'message', prompt: 'stall' });
		await waitForToolInput(projectId);
		await expect(request('/evict', projectId)).rejects.toThrow('Simulated session eviction');
		await waitForStatus(projectId, 'error');
		expect(await request('/file', projectId)).toEqual({ content: 'baseline' });
		await request('/submit', projectId, { messageId: 'next', prompt: 'hello' });
		await waitForStatus(projectId, 'completed');
		expect(await request('/session', projectId)).not.toHaveProperty('errorMessage');
	});

	it('stops an unfinished tool argument stream and completes a new turn without a stale error', async () => {
		const projectId = await createProject();
		await request('/submit', projectId, { messageId: 'message', prompt: 'stall' });
		await waitForToolInput(projectId);
		expect(await request('/submit', projectId, { messageId: 'queued', prompt: 'hello' })).toMatchObject({ queued: true });
		await request('/stop', projectId);
		expect(await request('/submission', projectId)).toMatchObject({ status: 'aborted' });
		expect(await request('/submission?message=queued', projectId)).toMatchObject({ status: 'aborted' });
		await waitForStatus(projectId, 'aborted');
		await request('/submit', projectId, { messageId: 'next', prompt: 'write' });
		await waitForStatus(projectId, 'completed');
		expect(await request('/session', projectId)).not.toHaveProperty('errorMessage');
	});

	it('clears a failed turn error after a successful retry and reload', async () => {
		const projectId = await createProject();
		await request('/submit', projectId, { messageId: 'message', prompt: 'fail' });
		await waitForStatus(projectId, 'error');
		await request('/submit', projectId, { messageId: 'next', prompt: 'hello' });
		await waitForStatus(projectId, 'completed');
		expect(await request('/session', projectId)).not.toHaveProperty('errorMessage');
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
					authorUserId: 'original-author',
					createdAt: 123_000,
					metadata: expect.objectContaining({ snapshotId: 'original-review' }),
				}),
				expect.objectContaining({ id: 'old-assistant', parts: [{ type: 'text', content: 'Previous answer'.repeat(1000) }] }),
				expect.objectContaining({ id: 'next' }),
				expect.objectContaining({ role: 'assistant', parts: [{ type: 'text', content: 'Earlier request retained' }] }),
			]),
		});
	});

	it('continues a reverted conversation with the forked context', async () => {
		const projectId = await createProject();
		await request('/seed-history', projectId);
		await request('/submit', projectId, { messageId: 'next', prompt: 'hello' });
		await waitForStatus(projectId, 'completed');
		const fork = z.object({ sessionId: z.string() }).parse(await request('/fork', projectId));
		await request(`/submit?session=${fork.sessionId}`, projectId, { messageId: 'fork-follow-up', prompt: 'recall' });
		await waitForStatus(projectId, 'completed');
		expect(await request(`/session?session=${fork.sessionId}`, projectId)).toMatchObject({
			history: expect.arrayContaining([
				expect.objectContaining({ role: 'assistant', parts: [{ type: 'text', content: 'Earlier request retained' }] }),
			]),
		});
	});
});
