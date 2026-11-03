import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { ContainerCapacityLedger } from './container-capacity-ledger';

describe('container capacity ledger', () => {
	it('bounds concurrent reservations, deduplicates a project, and fences stale release', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (_project, state) => {
			const ledger = new ContainerCapacityLedger(state.storage.kv);
			const results = await Promise.all(
				Array.from({ length: 20 }, (_, index) =>
					Promise.resolve().then(() => ledger.reserve({ projectId: `project-${index}`, token: `start-${index}` }, 3)),
				),
			);
			expect(results.filter(Boolean)).toHaveLength(3);
			expect(ledger.reserve({ projectId: 'project-0', token: 'replacement' }, 3)).toBe(true);
			expect(ledger.release('project-0', 'start-0')).toBe(false);
			expect(ledger.capacity(3).currentRunningContainers).toBe(3);
			expect(ledger.release('project-0', 'replacement')).toBe(true);
			expect(ledger.reserve({ projectId: 'next', token: 'start' }, 3)).toBe(true);
		});
	});
	it('adopts existing containers above a reduced limit and blocks new starts until they drain', async () => {
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), (_project, state) => {
			const ledger = new ContainerCapacityLedger(state.storage.kv);
			ledger.adopt({ projectId: 'one', token: 'one' });
			ledger.adopt({ projectId: 'two', token: 'two' });
			ledger.adopt({ projectId: 'one', token: 'stale' });
			expect(ledger.reserve({ projectId: 'three', token: 'three' }, 1)).toBe(false);
			expect(ledger.reserve({ projectId: 'one', token: 'restart' }, 0)).toBe(true);
			expect(new ContainerCapacityLedger(state.storage.kv).capacity(0).currentRunningContainers).toBe(2);
			ledger.release('one', 'restart');
			ledger.release('two', 'two');
			expect(ledger.reserve({ projectId: 'three', token: 'three' }, 0)).toBe(false);
			expect(ledger.reserve({ projectId: 'three', token: 'three' }, 1)).toBe(true);
		});
	});
});
