import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryFs, createMockContext, createMockSendEvent } from './test-helpers';

const memoryFs = createMemoryFs();
const generateImage = vi.fn(async () => new Uint8Array([137, 80, 78, 71]));

vi.mock('@worker/lib/project-fs', () => memoryFs.asMock());
vi.mock('cloudflare:workers', () => ({ env: { AI: { run: generateImage } } }));
vi.mock('@worker/lib/durable-object-namespaces', () => ({
	coordinatorNamespace: { getByName: () => ({ triggerUpdate: async () => {} }) },
}));

const { execute } = await import('./image-generate');

describe('image_generate', () => {
	beforeEach(() => {
		memoryFs.reset();
		generateImage.mockClear();
	});

	it('rejects an existing image without generating or overwriting it', async () => {
		memoryFs.seedFile('/project/public/image.png', 'existing image');

		await expect(
			execute({ prompt: 'An icon', file_path: '/public/image.png' }, createMockSendEvent(), createMockContext()),
		).rejects.toThrow('File already exists');

		expect(generateImage).not.toHaveBeenCalled();
		expect(memoryFs.store.get('/project/public/image.png')?.content).toBe('existing image');
	});

	it('creates a new image and reports it to the UI', async () => {
		const sendEvent = createMockSendEvent();
		await execute({ prompt: 'An icon', file_path: '/public/image.png' }, sendEvent, createMockContext());

		expect(generateImage).toHaveBeenCalledOnce();
		expect(memoryFs.store.get('/project/public/image.png')?.content).toBeDefined();
		expect(sendEvent.calls).toContainEqual(['file_changed', { path: '/public/image.png', action: 'create', isBinary: true }]);
	});
});
