import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContainerLimitReachedError } from '@shared/container-capacity';
import { WorkerResourceLimitError } from '@shared/worker-resource-budget';

import { PreviewService } from './preview-service';
import { generateProjectId } from '../lib/project-id';
import { containerViteRuntime } from './vite-host/runtimes/container-vite';
import { reactSpaRuntime } from './vite-host/runtimes/react-spa';

async function fixture() {
	const project = env.DurableObjectFilesystem.getByName(crypto.randomUUID());
	const projectId = await runInDurableObject(project, (_project, state) => generateProjectId(state.id));
	const decision = await project.getBuildRuntimeDecision({ 'package.json': '{}' });
	const bootstrap = {
		exists: true,
		packageJson: '{}',
		routerFirstEntries: {},
		configurationFiles: {},
		snapshotHash: 'snapshot',
		runtimeDecision: decision,
	};
	return { project, service: new PreviewService('/workspace', projectId), bootstrap };
}

describe('adaptive preview host', () => {
	afterEach(() => vi.restoreAllMocks());
	it('keeps the serving Worker and reports blocked capacity when fallback cannot start', async () => {
		const { project, service, bootstrap } = await fixture();
		await project.reportRuntimeStatus('preview', bootstrap.runtimeDecision, 'ready');
		vi.spyOn(reactSpaRuntime, 'serve').mockRejectedValue(new WorkerResourceLimitError());
		const capacity = { currentRunningContainers: 3, maxRunningContainers: 3 };
		vi.spyOn(containerViteRuntime, 'serve').mockRejectedValue(new ContainerLimitReachedError(capacity));
		await expect(service.routePreviewRequest(new Request('https://preview.test/'), 'https://ide.test', bootstrap)).rejects.toThrow(
			'CONTAINER_LIMIT_REACHED',
		);
		const status = await project.getRuntimeStatus();
		expect(status.preview).toMatchObject({ backend: 'worker', target: 'container', phase: 'blocked', capacity });
	});
	it('falls back for unsupported Vite configuration without trying to serve an incorrect Worker build', async () => {
		const { service, bootstrap } = await fixture();
		const worker = vi.spyOn(reactSpaRuntime, 'serve');
		const native = vi.spyOn(containerViteRuntime, 'serve').mockResolvedValue(new Response('Ready'));
		await service.routePreviewRequest(new Request('https://preview.test/'), 'https://ide.test', {
			...bootstrap,
			configurationFiles: { '/vite.config.ts': 'export default { resolve: { alias: { custom: "/src/custom" } } }' },
		});
		expect(worker).not.toHaveBeenCalled();
		expect(native).toHaveBeenCalledOnce();
	});
	it('keeps supported Vite configuration on Worker without starting a container', async () => {
		const { project, service, bootstrap } = await fixture();
		const worker = vi.spyOn(reactSpaRuntime, 'serve').mockResolvedValue(new Response('Ready'));
		const native = vi.spyOn(containerViteRuntime, 'serve');
		const response = await service.routePreviewRequest(new Request('https://preview.test/'), 'https://ide.test', {
			...bootstrap,
			configurationFiles: {
				'/vite.config.ts': `import react from '@vitejs/plugin-react'; export default {plugins: [react()]};`,
			},
		});
		expect(response.headers.get('X-Worker-Ide-Runtime')).toBe('worker');
		expect(worker).toHaveBeenCalledOnce();
		expect(native).not.toHaveBeenCalled();
		const status = await project.getRuntimeStatus();
		expect(status.preview.backend).toBe('worker');
	});
	it.each(['export default {', 'export default { plugins: [missing()] }'])('does not promote broken Vite configuration', async (source) => {
		const { project, service, bootstrap } = await fixture();
		const native = vi.spyOn(containerViteRuntime, 'serve');
		await expect(
			service.routePreviewRequest(new Request('https://preview.test/'), 'https://ide.test', {
				...bootstrap,
				configurationFiles: { '/vite.config.ts': source },
			}),
		).rejects.toThrow();
		expect(native).not.toHaveBeenCalled();
		const status = await project.getRuntimeStatus();
		expect(status.preview.target).toBe('worker');
	});
	it('warms a container after a Worker resource failure and annotates its response', async () => {
		const { project, service, bootstrap } = await fixture();
		vi.spyOn(reactSpaRuntime, 'serve').mockRejectedValue(new WorkerResourceLimitError());
		const native = vi
			.spyOn(containerViteRuntime, 'serve')
			.mockImplementation(
				async () => new Response('<html><head></head><body>Ready</body></html>', { headers: { 'Content-Type': 'text/html' } }),
			);
		const response = await service.routePreviewRequest(new Request('https://preview.test/'), 'https://ide.test', bootstrap);
		expect(response.headers.get('X-Worker-Ide-Runtime')).toBe('container');
		expect(await response.text()).toContain('__preview-runtime-switch');
		expect(native).toHaveBeenCalledOnce();
		const status = await project.getRuntimeStatus();
		const decision = await project.getBuildRuntimeDecision({});
		expect(status.preview).toMatchObject({ backend: 'container', reason: 'resource-limit' });
		expect(decision.backend).toBe('container');
	});
	it.each([new Error('Unexpected token'), new Error('Package not found')])('does not hide application errors', async (error) => {
		const { service, bootstrap } = await fixture();
		vi.spyOn(reactSpaRuntime, 'serve').mockRejectedValue(error);
		const native = vi.spyOn(containerViteRuntime, 'serve');
		await expect(service.routePreviewRequest(new Request('https://preview.test/'), 'https://ide.test', bootstrap)).rejects.toThrow(
			error.message,
		);
		expect(native).not.toHaveBeenCalled();
	});
	it('does not replay application mutations on a resource failure', async () => {
		const { service, bootstrap } = await fixture();
		const worker = vi.spyOn(reactSpaRuntime, 'serve').mockRejectedValue(new WorkerResourceLimitError());
		const native = vi.spyOn(containerViteRuntime, 'serve');
		await expect(
			service.routePreviewRequest(new Request('https://preview.test/api/action', { method: 'POST' }), 'https://ide.test', bootstrap),
		).rejects.toThrow('WORKER_RESOURCE_LIMIT');
		expect(worker).toHaveBeenCalledOnce();
		expect(native).not.toHaveBeenCalled();
	});
});
