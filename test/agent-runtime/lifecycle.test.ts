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

async function waitForStatus(projectId: string, status: string) {
	await vi.waitFor(
		async () => {
			expect(await request('/state', projectId)).toMatchObject({ status, stopRequested: false });
		},
		{ timeout: 4000, interval: 25 },
	);
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
				expect.objectContaining({ id: 'old-user' }),
				expect.objectContaining({ id: 'old-assistant' }),
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
