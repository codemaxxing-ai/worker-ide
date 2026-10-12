import { Buffer } from 'node:buffer';

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

import { getDomainConfiguration } from '../lib/domain-configuration';
import { addFileToSnapshot, initSnapshot } from '../services/agent/snapshot-manager';

import type { FileChange, ModelMessage } from '../services/agent/types';
import type { AppEnvironment } from '../types';

const seedSnapshotSchema = z.object({
	label: z.string().optional(),
	sessionId: z.string().optional(),
	changes: z
		.array(
			z.object({
				path: z.string(),
				action: z.enum(['create', 'edit', 'delete']),
				beforeContent: z.string().optional(),
			}),
		)
		.min(1),
});

/**
 * Dev/test-only routes. These are mounted only when `import.meta.env.DEV` is
 * truthy (see worker/index.ts) and must never be available in production.
 *
 * The integration suite uses these to seed internal fixtures (e.g. agent
 * snapshots) through the *real* internal mechanisms — the same
 * snapshot-manager functions the agent uses — instead of writing hidden files
 * via the public file API (which now rejects hidden paths).
 */
export const developmentTestRoutes = new Hono<AppEnvironment>()
	.post('/__test/seed-snapshot', zValidator('json', seedSnapshotSchema), async (c) => {
		const projectRoot = c.get('projectRoot');
		const { label, sessionId, changes } = c.req.valid('json');

		// initSnapshot derives the label from the last user message; synthesize
		// one so callers can control the label deterministically.
		const messages: ModelMessage[] = label === undefined ? [] : [{ role: 'user', content: label }];

		const context = await initSnapshot(projectRoot, sessionId, messages, () => {});

		for (const change of changes) {
			const fileChange: FileChange = {
				path: change.path,
				action: change.action,
				beforeContent: change.beforeContent,
				afterContent: undefined,
				isBinary: false,
			};
			await addFileToSnapshot(context, fileChange);
		}

		return c.json({ id: context.id });
	})
	.post(
		'/__test/computer-exec',
		zValidator(
			'json',
			z.object({
				command: z.string(),
				backend: z.enum(['shell', 'container']).default('shell'),
				id: z.string().optional(),
				sessionId: z.string().default('computer-integration'),
				snapshot: z.boolean().default(false),
			}),
		),
		async (c) => {
			const input = c.req.valid('json');
			const project = c.get('fsStub');

			await project.registerComputerSession(input.sessionId, 'code', getDomainConfiguration(c.env));
			using result = await project.computerExec(
				input.command,
				{ id: input.id ?? crypto.randomUUID(), backend: input.backend },
				input.sessionId,
			);
			using changes = await project.drainWorkspaceChanges(input.sessionId);
			let snapshotId: string | undefined;
			if (input.snapshot) {
				const snapshot = await initSnapshot(c.get('projectRoot'), input.sessionId, [], () => {});
				for (const change of changes) {
					await addFileToSnapshot(snapshot, {
						path: change.path,
						action: change.type === 'create' ? 'create' : change.type === 'delete' ? 'delete' : 'edit',
						isBinary: change.isBinary,
						beforeContent: change.beforeBytes ? new Uint8Array(Buffer.from(change.beforeBytes, 'base64')) : change.beforeContent,
						afterContent: undefined,
						entryType: change.entryType,
						beforeEntryType: change.beforeEntryType,
					});
				}
				snapshotId = snapshot.id;
			}
			return c.json({ result: { ...result }, changes: changes.map((change) => ({ ...change })), snapshotId });
		},
	)
	.get('/__test/computer-executions', zValidator('query', z.object({ sessionId: z.string() })), async (c) => {
		using executions = await c.get('fsStub').getComputerExecutions(c.req.valid('query').sessionId);
		return c.json({ executions: executions.map((execution) => ({ ...execution })) });
	})
	.post('/__test/computer-cancel', zValidator('json', z.object({ id: z.string(), sessionId: z.string() })), async (c) => {
		const { id, sessionId } = c.req.valid('json');
		await c.get('fsStub').cancelComputerExecution(id, sessionId);
		return c.json({ success: true });
	});

export type DevelopmentTestRoutes = typeof developmentTestRoutes;
