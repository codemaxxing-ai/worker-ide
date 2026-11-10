import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { DEFAULT_AI_MODEL } from '@shared/constants';
import { runWithProjectStub } from '@worker/lib/project-fs';

import { finalizeAgentChanges } from './finalize-changes';
import { initSnapshot } from './snapshot-manager';

import type { PendingAgentFinalization } from './finalize-changes';

describe('durable change finalization', () => {
	it('recovers a lost change reply and repeats snapshot checkpointing without changing the original backup', async () => {
		const project = env.DurableObjectFilesystem.getByName(crypto.randomUUID());
		await project.writeFileContent('/source.txt', 'before');
		await project.beginComputerSessionTurn('session', 'turn', 'code');
		const snapshot = await runWithProjectStub(project, () => initSnapshot('/project', 'session', [], () => {}));
		await project.wsWriteFile('/source.txt', 'after', 'session');
		await project.claimAgentChanges('session', 'turn', 'lost-reply');
		const pending: PendingAgentFinalization = {
			submissionId: 'turn',
			status: 'aborted',
			changesPrepared: false,
			changes: {},
			snapshot: { id: snapshot.id, directory: snapshot.directory, savedPaths: [] },
		};
		const configuration = { projectId: 'project', sessionId: 'session', model: DEFAULT_AI_MODEL, mode: 'code' } satisfies Parameters<
			typeof finalizeAgentChanges
		>[1];
		await expect(
			finalizeAgentChanges(project, configuration, pending, () => {
				throw new Error('Interrupted before checkpoint');
			}),
		).rejects.toThrow('Interrupted before checkpoint');
		expect(await project.getAgentChangeReceiptIds('session', 'turn')).toEqual(['lost-reply']);
		const completed = await finalizeAgentChanges(project, configuration, pending, () => {});
		expect(completed.changes['/source.txt']).toMatchObject({ beforeContent: 'before', afterContent: 'after' });
		expect(await project.wsReadFile(`/.agent/snapshots/${snapshot.id}/source.txt`)).toBe('before');
		const raw = await project.wsReadFile(`/.agent/snapshots/${snapshot.id}/metadata.json`);
		if (!raw) throw new Error('Missing snapshot');
		expect(JSON.parse(raw).changes).toHaveLength(1);
		expect(await project.getAgentChangeReceiptIds('session', 'turn')).toEqual([]);
	});
});
