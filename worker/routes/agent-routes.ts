import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';

import { createAgentUserMessage, parseAgentHistoryPage } from '@shared/agent-chat';
import { HttpErrorCode } from '@shared/http-errors';
import { aiModelSchema, debugLogIdSchema, sessionIdSchema } from '@shared/validation';
import { fs } from '@worker/lib/project-fs';

import { getDomainConfiguration } from '../lib/domain-configuration';
import { projectAgentNamespace } from '../lib/durable-object-namespaces';
import { httpError } from '../lib/http-error';
import { sanitizeSubmittedUserMessageParts, getUserMessagePromptText } from '../services/agent/submission-input';

import type { AppEnvironment } from '../types';
const sessionParameter = z.object({ sessionId: z.string().uuid() });
const settingsSchema = z.object({ mode: z.enum(['code', 'plan', 'ask']), model: aiModelSchema });
const messageSchema = z.object({ messageId: z.string().min(1).max(128), parts: z.array(z.unknown()).min(1).max(256) });

export const agentRoutes = new Hono<AppEnvironment>()
	.get('/agent/sessions', async (c) =>
		c.json({ sessions: await projectAgentNamespace.getByName(`agent:${c.get('projectId')}`).listSessions() }),
	)
	.post(
		'/agent/sessions',
		zValidator(
			'json',
			z.object({
				id: z.string().uuid(),
				title: z.string().optional(),
				mode: settingsSchema.shape.mode.optional(),
				model: aiModelSchema.optional(),
			}),
		),
		async (c) => {
			const project = await c.env.DB.prepare('SELECT organization_id FROM project WHERE id = ?')
				.bind(c.get('projectId'))
				.first<{ organization_id: string }>();
			const session = await projectAgentNamespace.getByName(`agent:${c.get('projectId')}`).createSession({
				...c.req.valid('json'),
				projectId: c.get('projectId'),
				organizationId: project?.organization_id,
				requestOriginContext: getDomainConfiguration(c.env),
			});
			return c.json({ session });
		},
	)
	.get('/agent/sessions/search', zValidator('query', z.object({ query: z.string().min(1).max(200) })), async (c) =>
		c.json({ matches: await projectAgentNamespace.getByName(`agent:${c.get('projectId')}`).searchSessions(c.req.valid('query').query) }),
	)
	.post(
		'/agent/sessions/:sessionId/submissions',
		bodyLimit({
			maxSize: 16 * 1024 * 1024,
			onError: () => {
				throw httpError(HttpErrorCode.VALIDATION_ERROR, 'Message is too large', 413);
			},
		}),
		zValidator('param', sessionParameter),
		zValidator('json', messageSchema),
		async (c) => {
			const { sessionId } = c.req.valid('param');
			const input = c.req.valid('json');
			const parts = sanitizeSubmittedUserMessageParts(input.parts);
			if (!getUserMessagePromptText(parts) && !parts.some((part) => part.type === 'image'))
				throw httpError(HttpErrorCode.VALIDATION_ERROR, 'A message is required');
			const author = await c.env.DB.prepare('SELECT name, image FROM user WHERE id = ?')
				.bind(c.get('session').userId)
				.first<{ name: string; image: unknown }>();
			const message = createAgentUserMessage(input.messageId, parts, {
				createdAt: Date.now(),
				authorUserId: c.get('session').userId,
				authorName: author?.name,
				authorImage: typeof author?.image === 'string' ? author.image : undefined,
				submissionId: input.messageId,
			});
			const result = await projectAgentNamespace.getByName(`agent:${c.get('projectId')}`).submitMessage(sessionId, message);
			return c.json(result);
		},
	)
	.get(
		'/agent/sessions/:sessionId/history',
		zValidator('param', sessionParameter),
		zValidator('query', z.object({ before: z.string().optional(), leafId: z.string().optional() })),
		async (c) => {
			return c.json(
				await parseAgentHistoryPage(
					await projectAgentNamespace
						.getByName(`agent:${c.get('projectId')}`)
						.readSessionHistory(c.req.valid('param').sessionId, c.req.valid('query').before, c.req.valid('query').leafId),
				),
			);
		},
	)
	.get(
		'/agent/sessions/:sessionId/branches',
		zValidator('param', sessionParameter),
		zValidator('query', z.object({ messageId: z.string() })),
		async (c) => {
			return c.json({
				branches: await projectAgentNamespace
					.getByName(`agent:${c.get('projectId')}`)
					.sessionBranches(c.req.valid('param').sessionId, c.req.valid('query').messageId),
			});
		},
	)
	.post('/agent/sessions/:sessionId/cancel', zValidator('param', sessionParameter), async (c) => {
		await projectAgentNamespace.getByName(`agent:${c.get('projectId')}`).cancelSession(c.req.valid('param').sessionId);
		return c.json({ success: true });
	})
	.delete(
		'/agent/sessions/:sessionId/submissions/:submissionId',
		zValidator('param', sessionParameter.extend({ submissionId: z.string() })),
		async (c) => {
			const { sessionId, submissionId } = c.req.valid('param');
			return c.json(
				await projectAgentNamespace
					.getByName(`agent:${c.get('projectId')}`)
					.cancelQueuedMessage(sessionId, submissionId, c.get('session').userId),
			);
		},
	)
	.put('/agent/sessions/:sessionId/settings', zValidator('param', sessionParameter), zValidator('json', settingsSchema), async (c) => {
		await projectAgentNamespace
			.getByName(`agent:${c.get('projectId')}`)
			.configureSession(c.req.valid('param').sessionId, c.req.valid('json'));
		return c.json({ success: true });
	})
	.put(
		'/agent/sessions/:sessionId/title',
		zValidator('param', sessionParameter),
		zValidator('json', z.object({ title: z.string().trim().min(1).max(100) })),
		async (c) => {
			await projectAgentNamespace
				.getByName(`agent:${c.get('projectId')}`)
				.renameSession(c.req.valid('param').sessionId, c.req.valid('json').title);
			return c.json({ success: true });
		},
	)
	.delete('/agent/sessions/:sessionId', zValidator('param', sessionParameter), async (c) => {
		await projectAgentNamespace.getByName(`agent:${c.get('projectId')}`).deleteSession(c.req.valid('param').sessionId);
		return c.json({ success: true });
	})
	// GET /api/agent/latest-debug-log-id?sessionId=X - Get the latest debug log ID for a session
	.get('/agent/latest-debug-log-id', zValidator('query', z.object({ sessionId: sessionIdSchema })), async (c) => {
		const projectRoot = c.get('projectRoot');
		const { sessionId } = c.req.valid('query');
		const logsDirectory = `${projectRoot}/.agent/sessions/${sessionId}/debug-logs`;

		try {
			const entries = await fs.readdir(logsDirectory);
			const logFiles = entries
				.filter((entry) => entry.endsWith('.json'))
				.toSorted((a, b) => {
					const timestampA = Number(a.slice(0, -5).split('-').pop()) || 0;
					const timestampB = Number(b.slice(0, -5).split('-').pop()) || 0;
					return timestampA - timestampB;
				});

			if (logFiles.length === 0) {
				return c.json({ id: '' });
			}

			const latestFile = logFiles.at(-1)!;
			return c.json({ id: latestFile.slice(0, -5) });
		} catch {
			return c.json({ id: '' });
		}
	})

	// GET /api/agent/debug-log?id=X&sessionId=Y - Download an agent debug log
	.get('/agent/debug-log', zValidator('query', z.object({ id: debugLogIdSchema, sessionId: sessionIdSchema })), async (c) => {
		const projectRoot = c.get('projectRoot');
		const { id, sessionId } = c.req.valid('query');

		const logPath = `${projectRoot}/.agent/sessions/${sessionId}/debug-logs/${id}.json`;
		let content: string;
		try {
			content = await fs.readFile(logPath, 'utf8');
		} catch (error) {
			if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
				throw httpError(HttpErrorCode.NOT_FOUND, 'Debug log not found');
			}
			console.error('Failed to read debug log file:', error);
			throw httpError(HttpErrorCode.INTERNAL_ERROR, 'Failed to read debug log');
		}

		try {
			JSON.parse(content);
		} catch {
			console.error(`Debug log file contains invalid JSON: ${logPath}`);
			throw httpError(HttpErrorCode.DATA_CORRUPTED, 'Debug log file is corrupted');
		}

		return c.body(content, 200, { 'Content-Type': 'application/json' });
	});

export type AgentRoutes = typeof agentRoutes;
