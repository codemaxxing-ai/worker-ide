import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { ComputerContainerHost, ComputerContainerSnapshots } from './computer-container-snapshots';

import type { ContainerLaunchSpec, ContainerRuntimeInfo } from '@cloudflare/computer/backends/container';

const DAY = 24 * 60 * 60 * 1000;
const SNAPSHOT_KEY = 'computer-container-snapshot';
const specification: ContainerLaunchSpec = { name: 'computer', env: {}, enableInternet: false, instance: 'standard-1' };

function fixture(storage: DurableObjectStorage['kv'], owner: string) {
	const clock = { now: 1_800_000_000_000 };
	const manifest = { hash: 'identical-dependencies' };
	const images = { computer: 'registry.test/computer@sha256:original' };
	const information = { image: images.computer, labels: { project: owner } };
	const container = {
		running: true,
		images,
		inspect: vi.fn(async () => information),
		snapshotContainer: vi.fn(async () => ({ id: `private-snapshot-${owner}`, size: 1024 })),
	};
	const dependencies = vi.fn(async () => manifest.hash);
	const cache = new ComputerContainerSnapshots(
		storage,
		owner,
		() => container,
		dependencies,
		() => clock.now,
	);
	const start = vi.fn(async (_specification: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> => {
		return { runtimeId: 'runtime', clientSecret: 'test-secret', outcome: 'launched' };
	});
	const restart = vi.fn(async (_specification: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> => {
		return { runtimeId: 'replacement', clientSecret: 'test-secret', outcome: 'relaunched' };
	});
	return { cache, clock, manifest, container, information, dependencies, start, restart };
}

describe('Project container snapshot cache', () => {
	it('launches through the real Computer host and resets preview state on cold restores', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (_project, state) => {
			const current = fixture(state.storage.kv, state.id.toString());
			let stopped = Promise.withResolvers<void>();
			const start = vi.fn((_options?: ContainerStartupOptions) => {
				container.running = true;
				stopped = Promise.withResolvers<void>();
			});
			const container: Container = {
				...current.container,
				running: false,
				start,
				monitor: () => stopped.promise,
				destroy: async () => {
					container.running = false;
					stopped.resolve();
				},
				signal: () => {},
				getTcpPort: () => env.ASSETS,
				setInactivityTimeout: async () => {},
				interceptOutboundHttp: async () => {},
				interceptAllOutboundHttp: async () => {},
				interceptOutboundHttps: async () => {},
				exec: async () => {
					throw new Error('Commands are outside this host test');
				},
			};
			const context: DurableObjectState = { ...state, storage: state.storage, id: state.id, container };
			const cache = new ComputerContainerSnapshots(state.storage.kv, state.id.toString(), () => container, current.dependencies);
			const onLaunch = vi.fn();
			const host = new ComputerContainerHost(context, cache, onLaunch, { launch: (operation) => operation() });
			await host.start({ ...specification, labels: { project: 'foreign' } });
			expect(start).toHaveBeenLastCalledWith(
				expect.objectContaining({ image: container.images.computer, labels: { project: state.id.toString() } }),
			);
			expect(onLaunch).toHaveBeenCalledOnce();
			await host.start(specification);
			expect(onLaunch).toHaveBeenCalledOnce();
			await cache.capture();
			await container.destroy();
			const restoreRequest = { ...specification };
			Reflect.set(restoreRequest, 'image', 'caller-supplied-image');
			await host.start(restoreRequest);
			expect(start).toHaveBeenLastCalledWith(
				expect.objectContaining({ containerSnapshot: { id: `private-snapshot-${state.id}` }, labels: { project: state.id.toString() } }),
			);
			expect(start.mock.lastCall?.[0]).not.toHaveProperty('image');
			expect(onLaunch).toHaveBeenCalledTimes(2);
			await host.restart(specification);
			expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ image: container.images.computer }));
			expect(start.mock.lastCall?.[0]).not.toHaveProperty('containerSnapshot');
			expect(onLaunch).toHaveBeenCalledTimes(3);
			host.restartOnNextStart();
			await host.start(specification);
			expect(onLaunch).toHaveBeenCalledTimes(4);
			expect(start.mock.lastCall?.[0]).not.toHaveProperty('containerSnapshot');
			await host.start(specification);
			expect(onLaunch).toHaveBeenCalledTimes(4);
			await expect(host.start({ ...specification, containerSnapshot: { id: 'foreign' } })).rejects.toThrow('Caller-provided');
			await container.destroy();
		});
	});

	it('restores only the owning project even when projects have identical dependencies', async () => {
		const firstProject = env.DurableObjectFilesystem.getByName(crypto.randomUUID());
		const secondProject = env.DurableObjectFilesystem.getByName(crypto.randomUUID());
		const firstRecord = await runInDurableObject(firstProject, async (_project, state) => {
			const current = fixture(state.storage.kv, state.id.toString());
			await current.cache.capture();
			current.container.running = false;
			const recovered = new ComputerContainerSnapshots(
				state.storage.kv,
				state.id.toString(),
				() => current.container,
				current.dependencies,
				() => current.clock.now,
			);
			await recovered.start(specification, current.start, current.restart);
			expect(current.start).toHaveBeenCalledWith(
				expect.objectContaining({ containerSnapshot: { id: `private-snapshot-${state.id}` }, labels: { project: state.id.toString() } }),
			);
			return state.storage.kv.get<Record<string, unknown>>(SNAPSHOT_KEY);
		});
		await runInDurableObject(secondProject, async (_project, state) => {
			const current = fixture(state.storage.kv, state.id.toString());
			await current.cache.capture();
			current.container.running = false;
			await current.cache.start(specification, current.start, current.restart);
			expect(current.start).toHaveBeenLastCalledWith(
				expect.objectContaining({ containerSnapshot: { id: `private-snapshot-${state.id}` } }),
			);
			// Copying a foreign record fails closed. Rewriting its owner cannot
			// authenticate it with this project's independently generated key.
			for (const record of [firstRecord, { ...firstRecord, owner: state.id.toString() }]) {
				state.storage.kv.put(SNAPSHOT_KEY, record);
				await current.cache.start(specification, current.start, current.restart);
				expect(current.start).toHaveBeenLastCalledWith({ ...specification, labels: { project: state.id.toString() } });
				expect(state.storage.kv.get(SNAPSHOT_KEY)).toBeUndefined();
			}
		});
	});

	it('rejects caller-provided snapshot handles on both launch paths', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (_project, state) => {
			const current = fixture(state.storage.kv, state.id.toString());
			for (const input of [
				{ ...specification, containerSnapshot: { id: 'foreign' } },
				{ ...specification, directorySnapshots: [{ snapshot: { id: 'foreign', size: 1, dir: '/' } }] },
			]) {
				await expect(current.cache.start(input, current.start, current.restart)).rejects.toThrow('Caller-provided');
				await expect(current.cache.restart(input, current.restart)).rejects.toThrow('Caller-provided');
			}
			expect(current.start).not.toHaveBeenCalled();
			expect(current.restart).not.toHaveBeenCalled();
		});
	});

	it.each(['image', 'dependencies', 'authentication', 'handle', 'future', 'malformed'])(
		'discards a cache with invalid %s metadata',
		async (changed) => {
			await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (_project, state) => {
				const current = fixture(state.storage.kv, state.id.toString());
				await current.cache.capture();
				const record = state.storage.kv.get<Record<string, unknown>>(SNAPSHOT_KEY);
				if (changed === 'image') current.container.images.computer = 'registry.test/computer@sha256:updated';
				if (changed === 'dependencies') current.manifest.hash = 'updated-dependencies';
				if (changed === 'authentication') state.storage.kv.put(SNAPSHOT_KEY, { ...record, authentication: '0'.repeat(64) });
				if (changed === 'handle') state.storage.kv.put(SNAPSHOT_KEY, { ...record, snapshot: { id: 'foreign', size: 1024 } });
				if (changed === 'future') current.clock.now -= 1;
				if (changed === 'malformed') state.storage.kv.put(SNAPSHOT_KEY, { snapshot: { id: 'foreign' } });
				current.container.running = false;
				await current.cache.start(specification, current.start, current.restart);
				expect(current.start).toHaveBeenCalledWith({ ...specification, labels: { project: state.id.toString() } });
				expect(state.storage.kv.get(SNAPSHOT_KEY)).toBeUndefined();
			});
		},
	);

	it('expires after seven days without extending the deadline on restore', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (_project, state) => {
			const current = fixture(state.storage.kv, state.id.toString());
			await current.cache.capture();
			const original = state.storage.kv.get(SNAPSHOT_KEY);
			current.container.running = false;
			current.clock.now += 7 * DAY - 1;
			await current.cache.start(specification, current.start, current.restart);
			expect(current.start).toHaveBeenLastCalledWith(expect.objectContaining({ containerSnapshot: expect.any(Object) }));
			expect(state.storage.kv.get(SNAPSHOT_KEY)).toEqual(original);
			current.clock.now++;
			await current.cache.start(specification, current.start, current.restart);
			expect(current.start).toHaveBeenLastCalledWith({ ...specification, labels: { project: state.id.toString() } });
			expect(state.storage.kv.get(SNAPSHOT_KEY)).toBeUndefined();
		});
	});

	it('reuses a valid cache and limits replacement captures to once per day', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (_project, state) => {
			const current = fixture(state.storage.kv, state.id.toString());
			await current.cache.capture();
			current.clock.now += DAY;
			await current.cache.capture();
			expect(current.container.snapshotContainer).toHaveBeenCalledOnce();
			current.manifest.hash = 'new-dependencies';
			await current.cache.capture();
			expect(current.container.snapshotContainer).toHaveBeenCalledTimes(2);
			current.manifest.hash = 'more-dependencies';
			current.clock.now += DAY - 1;
			await current.cache.capture();
			expect(current.container.snapshotContainer).toHaveBeenCalledTimes(2);
			expect(state.storage.kv.get(SNAPSHOT_KEY)).toBeUndefined();
			current.clock.now++;
			await current.cache.capture();
			expect(current.container.snapshotContainer).toHaveBeenCalledTimes(3);
			expect([...state.storage.kv.list({ prefix: SNAPSHOT_KEY })]).toHaveLength(3);
		});
	});

	it('falls back to the image for rejected restores and failed startup health checks', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (_project, state) => {
			const current = fixture(state.storage.kv, state.id.toString());
			await current.cache.capture();
			current.container.running = false;
			current.start.mockRejectedValueOnce(new Error('Snapshot unavailable'));
			await current.cache.start(specification, current.start, current.restart);
			expect(current.restart).toHaveBeenLastCalledWith({ ...specification, labels: { project: state.id.toString() } });
			expect(state.storage.kv.get(SNAPSHOT_KEY)).toBeUndefined();
			current.container.running = true;
			current.clock.now += DAY;
			await current.cache.capture();
			await current.cache.restart(specification, current.restart);
			expect(current.restart).toHaveBeenLastCalledWith({ ...specification, labels: { project: state.id.toString() } });
			expect(state.storage.kv.get(SNAPSHOT_KEY)).toBeUndefined();
		});
	});

	it.each(['owner', 'image', 'stopped'])('does not capture a container with mismatched %s', async (changed) => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (_project, state) => {
			const current = fixture(state.storage.kv, state.id.toString());
			if (changed === 'owner') current.information.labels.project = 'another-project';
			if (changed === 'image') current.information.image = 'previous-image';
			if (changed === 'stopped') current.container.running = false;
			await current.cache.capture();
			expect(current.container.snapshotContainer).not.toHaveBeenCalled();
			expect(state.storage.kv.get(SNAPSHOT_KEY)).toBeUndefined();
		});
	});

	it('treats capture failure as optional and throttles retries', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (_project, state) => {
			const current = fixture(state.storage.kv, state.id.toString());
			current.container.snapshotContainer.mockRejectedValue(new Error('Snapshots unavailable'));
			await expect(current.cache.capture()).resolves.toBeUndefined();
			await current.cache.capture();
			expect(current.container.snapshotContainer).toHaveBeenCalledOnce();
			expect(state.storage.kv.get(SNAPSHOT_KEY)).toBeUndefined();
		});
	});

	it('does not restore a handle cleared during capture', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (_project, state) => {
			const current = fixture(state.storage.kv, state.id.toString());
			const started = Promise.withResolvers<void>();
			const completed = Promise.withResolvers<ContainerSnapshot>();
			current.container.snapshotContainer.mockImplementation(async () => {
				started.resolve();
				return completed.promise;
			});
			const capturing = current.cache.capture();
			await started.promise;
			current.cache.clear();
			completed.resolve({ id: 'discarded', size: 1 });
			await capturing;
			expect(state.storage.kv.get(SNAPSHOT_KEY)).toBeUndefined();
			expect(state.storage.kv.get('computer-container-snapshot-key')).toBeUndefined();
		});
	});

	it('clears snapshot records and authentication keys when the project is deleted', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (project, state) => {
			const current = fixture(state.storage.kv, state.id.toString());
			await current.cache.capture();
			Reflect.set(project, 'containerSnapshotsInstance', current.cache);
			await project.destroyStorage();
			expect([...state.storage.kv.list({ prefix: SNAPSHOT_KEY })]).toHaveLength(0);
			current.container.running = false;
			await current.cache.start(specification, current.start, current.restart);
			expect(current.start).toHaveBeenLastCalledWith({ ...specification, labels: { project: state.id.toString() } });
		});
	});
});
