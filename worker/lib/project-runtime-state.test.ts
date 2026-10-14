import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { WORKER_MODULE_BYTE_BUDGET } from '@shared/worker-resource-budget';

import { ProjectRuntimeState } from './project-runtime-state';

describe('durable runtime decisions', () => {
	it('reports a native wake or startup failure without selecting a stale runtime', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (project, state) => {
			const decision = project.getBuildRuntimeDecision({ 'package.json': JSON.stringify({ workerIde: { runtime: 'container' } }) });
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
			const worker = project.getBuildRuntimeDecision({ 'package.json': JSON.stringify({ workerIde: { runtime: 'worker' } }) });
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
				backend: 'worker',
				reason: 'explicit-choice',
			});
		});
	});
});
