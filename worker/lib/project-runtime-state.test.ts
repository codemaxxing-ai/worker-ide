import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { buildPreviewOrigin } from '@shared/domain';
import { WORKER_MODULE_BYTE_BUDGET } from '@shared/worker-resource-budget';

import { generateProjectId } from './project-id';
import { ProjectRuntimeState } from './project-runtime-state';

import type { RuntimeDecision } from '@shared/runtime-status';

describe('durable runtime decisions', () => {
	it('waits for synchronization, coalesces restarts and warms a new shared generation', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (project, state) => {
			await project.wsWriteFile('/package.json', '{"name":"restart-test"}');
			const before = await project.wsReadFile('/package.json');
			const runtime = new ProjectRuntimeState(state.storage.kv);
			runtime.promote('explicit-choice');
			const decision = runtime.select('container', 'explicit-choice');
			await project.reportRuntimeStatus('preview', decision, 'ready');
			Reflect.set(project, 'admissionInstance', { inspect: () => ({ starting: true }) });
			const close = vi.fn(async () => {});
			const push = vi.fn(async function* () {
				yield;
			});
			const restartOnNextStart = vi.fn();
			Reflect.set(project, 'computerInstance', { close, push });
			Reflect.set(project, 'containerHost', { restartOnNextStart });
			const warm = vi.fn(async () => {
				const selected = state.storage.kv.get<RuntimeDecision>('project-runtime-decision');
				if (!selected) throw new Error('Missing runtime decision');
				await project.reportRuntimeStatus('preview', selected, 'ready');
				return new Response('Ready');
			});
			Reflect.set(project, 'nativePreviewFetch', warm);
			const synchronized = Promise.withResolvers<void>();
			const active = Reflect.get(project, 'queue').run('active-command', [], () => synchronized.promise);
			const first = project.restartContainer('https://preview.test', 'https://ide.test', 'https://content.test');
			const second = project.restartContainer('https://preview.test', 'https://ide.test', 'https://content.test');
			const external = project.fetch(new Request(buildPreviewOrigin(generateProjectId(state.id), '000000000000', env.CONTENT_ORIGIN)));
			expect(close).not.toHaveBeenCalled();
			expect(warm).not.toHaveBeenCalled();
			synchronized.resolve();
			await active;
			const [result, duplicate] = await Promise.all([first, second]);
			expect(close).toHaveBeenCalledOnce();
			expect(restartOnNextStart).toHaveBeenCalledOnce();
			expect(push).toHaveBeenCalledExactlyOnceWith('container');
			await external;
			expect(warm).toHaveBeenCalledTimes(2);
			expect(result).toEqual(duplicate);
			expect(result.preview).toMatchObject({ backend: 'container', phase: 'ready', generation: decision.generation + 1 });
			expect(project.getRuntimeSettings()).toEqual({ alwaysUseContainer: false });
			expect(await project.wsReadFile('/package.json')).toBe(before);
			expect(runtime.update('preview', decision, 'ready')).toBeUndefined();
		});
	});
	it('reports a failed restart while retaining the container preview and permits a fresh retry', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (project, state) => {
			const runtime = new ProjectRuntimeState(state.storage.kv);
			runtime.promote('explicit-choice');
			await project.reportRuntimeStatus('preview', runtime.select('container', 'explicit-choice'), 'ready');
			Reflect.set(project, 'admissionInstance', { inspect: () => ({ starting: true }) });
			const push = vi.fn(() => {
				throw new Error('Restart failed');
			});
			Reflect.set(project, 'computerInstance', { close: async () => {}, push });
			Reflect.set(project, 'containerHost', { restartOnNextStart: () => {} });
			await expect(project.restartContainer('https://preview.test', 'https://ide.test', 'https://content.test')).rejects.toThrow(
				'Restart failed',
			);
			expect(runtime.status.preview).toMatchObject({ backend: 'container', target: 'container', phase: 'error', generation: 2 });
			await expect(project.restartContainer('https://preview.test', 'https://ide.test', 'https://content.test')).rejects.toThrow(
				'Restart failed',
			);
			expect(push).toHaveBeenCalledTimes(2);
			expect(runtime.status.preview.generation).toBe(3);
		});
	});
	it('does not turn obsolete decisions or promotion keys into a current container session', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), (_project, state) => {
			state.storage.kv.put('project-runtime-promoted', true);
			state.storage.kv.put('project-runtime-session', 'project-requirements');
			state.storage.kv.put('project-runtime-decision', { backend: 'container', reason: 'project-requirements', generation: 5 });
			const runtime = new ProjectRuntimeState(state.storage.kv);
			runtime.reconcile(true);
			expect(runtime.promoted).toBe(false);
			expect(runtime.alwaysUseContainer).toBe(false);
			expect(runtime.select('worker', 'simple-project')).toEqual({ backend: 'worker', reason: 'simple-project', generation: 6 });
		});
	});
	it('disabling the persistent setting keeps the selected container for the current session', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), (project, state) => {
			project.setRuntimeSettings(true);
			const container = project.getBuildRuntimeDecision({});
			project.setRuntimeSettings(false);
			expect(project.getBuildRuntimeDecision({})).toEqual(container);
			new ProjectRuntimeState(state.storage.kv).endSession();
			expect(project.getBuildRuntimeDecision({}).backend).toBe('worker');
		});
	});
	it('keeps the session during a container restart', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), (project, state) => {
			const runtime = new ProjectRuntimeState(state.storage.kv);
			runtime.promote('explicit-choice');
			const container = runtime.select('container', 'explicit-choice');
			runtime.reconcile(true);
			const admission = { starting: true };
			Reflect.set(project, 'admissionInstance', { inspect: () => admission });
			expect(project.getBuildRuntimeDecision({})).toEqual(container);
			admission.starting = false;
			expect(project.getBuildRuntimeDecision({}).backend).toBe('worker');
		});
	});
	it('rejects late readiness from a stopped container session', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), (_project, state) => {
			const runtime = new ProjectRuntimeState(state.storage.kv);
			runtime.promote('explicit-choice');
			const container = runtime.select('container', 'explicit-choice');
			runtime.reconcile(true);
			runtime.update('preview', container, 'ready');
			runtime.reconcile(false);
			expect(runtime.promoted).toBe(false);
			expect(runtime.update('preview', container, 'ready')).toBeUndefined();
			expect(runtime.select('worker', 'simple-project').generation).toBeGreaterThan(container.generation);
		});
	});
	it('ends temporary promotion on shutdown while metadata survives and files stay unchanged', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (project, state) => {
			await project.wsWriteFile('/package.json', '{"name":"untouched","workerIde":{"runtime":"container"}}');
			const before = await project.wsReadFile('/package.json');
			expect(project.getBuildRuntimeDecision({ '/package.json': String(before) }).backend).toBe('worker');
			const runtime = new ProjectRuntimeState(state.storage.kv);
			runtime.promote('explicit-choice');
			runtime.reconcile(true);
			expect(project.getBuildRuntimeDecision({}).backend).toBe('worker');
			project.setRuntimeSettings(true);
			expect(project.getBuildRuntimeDecision({}).backend).toBe('container');
			runtime.endSession();
			expect(new ProjectRuntimeState(state.storage.kv).alwaysUseContainer).toBe(true);
			project.setRuntimeSettings(false);
			expect(project.getBuildRuntimeDecision({}).backend).toBe('worker');
			expect(await project.wsReadFile('/package.json')).toBe(before);
		});
	});
	it('reports a native wake or startup failure without selecting a stale runtime', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (project, state) => {
			project.setRuntimeSettings(true);
			const decision = project.getBuildRuntimeDecision({});
			await project.reportRuntimeStatus('preview', decision, 'sleeping');
			Reflect.set(project, 'serveNativePreview', async () => new Response('Ready'));
			const request = new Request('https://preview.test/');
			await Reflect.get(project, 'nativePreviewFetch').call(project, request, 'https://ide.test', 'https://preview.test');
			expect(state.storage.kv.get('project-runtime-status')).toMatchObject({ preview: { backend: 'container', phase: 'ready' } });
			Reflect.set(project, 'serveNativePreview', async () => {
				throw new Error('Native startup failed');
			});
			await expect(
				Reflect.get(project, 'nativePreviewFetch').call(project, request, 'https://ide.test', 'https://preview.test'),
			).rejects.toThrow('Native startup failed');
			expect(state.storage.kv.get('project-runtime-status')).toMatchObject({ preview: { backend: 'container', phase: 'error' } });
			project.setRuntimeSettings(false);
			new ProjectRuntimeState(state.storage.kv).endSession();
			const worker = project.getBuildRuntimeDecision({});
			await project.reportRuntimeStatus('preview', worker, 'ready');
			Reflect.set(project, 'serveNativePreview', async () => new Response('Old native socket'));
			await Reflect.get(project, 'nativePreviewFetch').call(project, request, 'https://ide.test', 'https://preview.test');
			expect(state.storage.kv.get('project-runtime-status')).toMatchObject({ preview: { backend: 'worker', phase: 'ready' } });
		});
	});
	it('retains promotion across reconstructed state and ignores stale completions', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (_project, state) => {
			const runtime = new ProjectRuntimeState(state.storage.kv);
			const worker = runtime.select('worker', 'simple-project');
			runtime.update('preview', worker, 'ready');
			runtime.promote();
			const container = runtime.select('container', 'resource-limit');
			expect(runtime.update('preview', container, 'starting')?.preview).toMatchObject({
				backend: 'worker',
				target: 'container',
				phase: 'switching',
			});
			expect(runtime.update('preview', worker, 'ready')).toBeUndefined();
			runtime.update('preview', container, 'ready');
			const recovered = new ProjectRuntimeState(state.storage.kv);
			expect(recovered.promoted).toBe(true);
			expect(recovered.status.preview).toMatchObject({ backend: 'container', phase: 'ready' });
			expect(recovered.update('preview', container, 'starting')).toBeUndefined();
			expect(recovered.status.revision).toBe(3);
			const explicitWorker = recovered.select('worker', 'explicit-choice');
			expect(recovered.update('preview', container, 'sleeping')?.preview.phase).toBe('sleeping');
			recovered.update('preview', explicitWorker, 'ready');
			expect(recovered.update('preview', container, 'sleeping')).toBeUndefined();
		});
	});
	it('tracks build separately and chooses by bytes without a package list', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (project) => {
			const files = { 'package.json': JSON.stringify({ dependencies: { 'an-unknown-library': '1' } }), 'src/main.ts': 'export default 1' };
			const worker = project.getBuildRuntimeDecision(files);
			expect(worker.backend).toBe('worker');
			const container = project.getBuildRuntimeDecision({ ...files, 'src/unknown.ts': ' '.repeat(WORKER_MODULE_BYTE_BUDGET + 1) });
			expect(container).toMatchObject({ backend: 'container', reason: 'resource-limit' });
			await project.reportRuntimeStatus('build', container, 'ready');
			const status = await project.getRuntimeStatus();
			expect(status.build.backend).toBe('container');
			expect(status.preview.phase).toBe('idle');
			expect(project.getBuildRuntimeDecision(files)).toEqual(container);
			expect(project.getBuildRuntimeDecision({ 'package.json': JSON.stringify({ workerIde: { runtime: 'worker' } }) })).toMatchObject({
				backend: 'container',
				reason: 'resource-limit',
			});
		});
	});
});
