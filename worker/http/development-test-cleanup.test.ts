import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { developmentTestCleanupRoutes } from './development-test-cleanup';

const { destroyStorage, closeConnections, cancelExecutions } = vi.hoisted(() => ({
	destroyStorage: vi.fn(),
	closeConnections: vi.fn(),
	cancelExecutions: vi.fn(),
}));
vi.mock('../lib/durable-object-namespaces', () => ({
	filesystemNamespace: {
		idFromString: (id: string) => id,
		get: (id: string) => ({ destroyStorage: () => destroyStorage(id), cancelComputerSessionExecutions: cancelExecutions }),
	},
	coordinatorNamespace: { getByName: () => ({ closeProjectConnections: closeConnections }) },
}));

beforeAll(async () => {
	await env.DB.exec(
		'CREATE TABLE IF NOT EXISTS project (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, durable_object_hex_id TEXT NOT NULL)',
	);
});
beforeEach(() => vi.clearAllMocks());

async function insertProject(organizationId = '11111111-1111-4111-8111-111111111111') {
	const id = crypto.randomUUID();
	await env.DB.prepare('INSERT INTO project (id, organization_id, durable_object_hex_id) VALUES (?, ?, ?)')
		.bind(id, organizationId, id)
		.run();
	return id;
}
async function exists(id: string) {
	return Boolean(await env.DB.prepare('SELECT id FROM project WHERE id = ?').bind(id).first());
}
function cleanup(projectIds: string[]) {
	return developmentTestCleanupRoutes.request(
		'/__test/cleanup',
		{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectIds }) },
		env,
	);
}

describe('development test cleanup', () => {
	it('releases the workspace before deleting its row and leaves other runs untouched', async () => {
		const own = await insertProject();
		const otherRun = await insertProject();
		const realProject = await insertProject('another-organization');
		destroyStorage.mockImplementationOnce(async (id: string) => {
			expect(cancelExecutions.mock.calls).toEqual([['native-preview'], ['native-build']]);
			expect(await exists(id)).toBe(true);
		});
		const response = await cleanup([own, realProject]);
		expect(response.status).toBe(200);
		expect(destroyStorage).toHaveBeenCalledExactlyOnceWith(own);
		expect(closeConnections).toHaveBeenCalledOnce();
		expect(await exists(own)).toBe(false);
		expect(await exists(otherRun)).toBe(true);
		expect(await exists(realProject)).toBe(true);
	});
	it('retains failed projects for retry while releasing the remaining projects', async () => {
		const failed = await insertProject();
		const succeeding = await insertProject();
		destroyStorage.mockImplementation(async (id: string) => {
			if (id === failed) throw new Error('Container unavailable');
		});
		const response = await cleanup([failed, succeeding]);
		expect(response.status).toBe(500);
		expect(await exists(failed)).toBe(true);
		expect(await exists(succeeding)).toBe(false);
		destroyStorage.mockResolvedValue();
		const retried = await cleanup([failed]);
		expect(retried.status).toBe(200);
		expect(await exists(failed)).toBe(false);
	});
	it('requires an explicit project list and safely handles repeated cleanup', async () => {
		const missingList = await developmentTestCleanupRoutes.request('/__test/cleanup', { method: 'POST' }, env);
		const emptyList = await cleanup([]);
		const alreadyDeleted = await cleanup([crypto.randomUUID()]);
		expect(missingList.status).toBe(400);
		expect(emptyList.status).toBe(200);
		expect(alreadyDeleted.status).toBe(200);
		expect(destroyStorage).not.toHaveBeenCalled();
	});
});
