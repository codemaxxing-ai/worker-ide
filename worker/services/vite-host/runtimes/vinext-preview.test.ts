import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
	let updateVersion = 7;
	return {
		markVinextPreview: vi.fn(async () => {}),
		getUpdateVersion: vi.fn(async () => updateVersion),
		getBuildArtifact: vi.fn(async () => {
			// An edit arrives while the build is running.
			updateVersion += 1;
			return { mainModule: 'server.js', serverModules: {}, clientOutput: {} };
		}),
	};
});

vi.mock('cloudflare:workers', () => ({ env: {}, exports: {}, tracing: undefined }));
vi.mock('../../../lib/durable-object-namespaces', () => ({
	coordinatorNamespace: {
		getByName: () => ({ markVinextPreview: mocks.markVinextPreview, getUpdateVersion: mocks.getUpdateVersion }),
	},
	filesystemNamespace: {},
}));
vi.mock('../../../lib/protected-files', () => ({ readBindingsConfig: async () => ({}) }));
vi.mock('../build-artifact-client', () => ({ getBuildArtifact: mocks.getBuildArtifact }));

import { serveVinextPreview } from './vinext-preview';

import type { ArtifactFrameworkRuntime } from './types';

describe('Worker vinext preview bootstrap', () => {
	it('captures the current version before building so reloads settle and concurrent edits remain detectable', async () => {
		const runtime: ArtifactFrameworkRuntime = {
			id: 'vinext',
			hosting: 'artifact',
			detect: () => true,
			serverCompatibilityFlags: [],
			hmrGlue: () => '',
			route: async () => new Response('<html><head></head><body>Hello</body></html>', { headers: { 'Content-Type': 'text/html' } }),
		};
		const response = await serveVinextPreview({
			request: new Request('https://preview.example/'),
			projectId: 'project-1',
			projectRoot: '/workspace',
			ideOrigin: 'https://ide.example',
			snapshotHash: 'snapshot-1',
			runtime,
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toContain('"bootVersion":7');
		expect(mocks.getUpdateVersion).toHaveBeenCalledTimes(1);
		expect(mocks.getBuildArtifact).toHaveBeenCalledTimes(1);
		expect(mocks.getUpdateVersion.mock.invocationCallOrder[0]).toBeLessThan(mocks.getBuildArtifact.mock.invocationCallOrder[0]);
	});
});
