import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveAssetSettings } from '@shared/types';
import { WorkerResourceLimitError } from '@shared/worker-resource-budget';

import { PreviewService } from './preview-service';
import { generateProjectId } from '../lib/project-id';
import { containerViteRuntime } from './vite-host/runtimes/container-vite';
import { reactSpaRuntime } from './vite-host/runtimes/react-spa';

async function fixture() {
	const project = env.DurableObjectFilesystem.getByName(crypto.randomUUID());
	const projectId = await runInDurableObject(project, (_project, state) => generateProjectId(state.id));
	const decision = await project.getBuildRuntimeDecision({ 'package.json': '{}' });
	const bootstrap = { exists: true, packageJson: '{}', routerFirstEntries: {}, snapshotHash: 'snapshot', runtimeDecision: decision };
	return { project, service: new PreviewService('/workspace', projectId), bootstrap };
}

describe('adaptive preview host', () => {
	afterEach(() => vi.restoreAllMocks());
	it('warms a container after a Worker resource failure and annotates its response', async () => {
		const { project, service, bootstrap } = await fixture();
		vi.spyOn(reactSpaRuntime, 'serve').mockRejectedValue(new WorkerResourceLimitError());
		const native = vi
			.spyOn(containerViteRuntime, 'serve')
			.mockImplementation(
				async () => new Response('<html><head></head><body>Ready</body></html>', { headers: { 'Content-Type': 'text/html' } }),
			);
		const response = await service.routePreviewRequest(
			new Request('https://preview.test/'),
			'https://ide.test',
			resolveAssetSettings(),
			'snapshot',
			bootstrap,
		);
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
		await expect(
			service.routePreviewRequest(new Request('https://preview.test/'), 'https://ide.test', resolveAssetSettings(), 'snapshot', bootstrap),
		).rejects.toThrow(error.message);
		expect(native).not.toHaveBeenCalled();
	});
	it('does not replay application mutations on a resource failure', async () => {
		const { service, bootstrap } = await fixture();
		const worker = vi.spyOn(reactSpaRuntime, 'serve').mockRejectedValue(new WorkerResourceLimitError());
		const native = vi.spyOn(containerViteRuntime, 'serve');
		await expect(
			service.routePreviewRequest(
				new Request('https://preview.test/api/action', { method: 'POST' }),
				'https://ide.test',
				resolveAssetSettings(),
				'snapshot',
				bootstrap,
			),
		).rejects.toThrow('WORKER_RESOURCE_LIMIT');
		expect(worker).toHaveBeenCalledOnce();
		expect(native).not.toHaveBeenCalled();
	});
});
