import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import { HttpErrorCode } from '@shared/http-errors';
import {
	gitStageSchema,
	gitDiscardSchema,
	gitCommitSchema,
	gitBranchSchema,
	gitBranchRenameSchema,
	gitCheckoutSchema,
	gitMergeSchema,
	gitTagSchema,
	gitLogQuerySchema,
	gitGraphQuerySchema,
	gitDiffQuerySchema,
	gitCommitDiffQuerySchema,
	gitFileDiffAtCommitQuerySchema,
	gitBranchNameQuerySchema,
	gitTagNameQuerySchema,
} from '@shared/validation';

import * as authSchema from '../db/auth-schema';
import { coordinatorNamespace } from '../lib/durable-object-namespaces';
import { httpError } from '../lib/http-error';

import type { AppEnvironment } from '../types';

/**
 * Look up the authenticated user's name and email from D1.
 * Falls back to defaults if the user is not found.
 */
async function getCommitAuthor(environment: Env, userId: string): Promise<{ name: string; email: string }> {
	const database = drizzle(environment.DB, { schema: authSchema });
	const userRow = await database
		.select({ name: authSchema.user.name, email: authSchema.user.email })
		.from(authSchema.user)
		.where(eq(authSchema.user.id, userId))
		.limit(1);
	return {
		name: userRow[0]?.name ?? 'IDE User',
		email: userRow[0]?.email ?? 'user@example.com',
	};
}

/**
 * Broadcast git-status-changed to connected WebSocket clients via the coordinator.
 */
function broadcastGitStatusChanged(projectId: string, executionContext: { waitUntil: (promise: Promise<unknown>) => void }): void {
	try {
		const coordinatorStub = coordinatorNamespace.getByName(`project:${projectId}`);
		executionContext.waitUntil(coordinatorStub.sendMessage({ type: 'git-status-changed' }).catch(() => {}));
	} catch {
		// Best-effort broadcast
	}
}

function messageOf(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

/**
 * Git routes. All git work runs inside the project Durable Object against its
 * durable `Workspace` (real `.git`, real index); these handlers are thin
 * HTTP/validation/broadcast wrappers over the DO's git RPC methods.
 */
export const gitRoutes = new Hono<AppEnvironment>()
	.post('/git/init', async (c) => {
		try {
			const author = await getCommitAuthor(c.env, c.get('session').userId);
			using result = await c.get('fsStub').gitInit(author);
			return c.json(result);
		} catch (error) {
			console.error('Git init error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, messageOf(error, 'Failed to initialize git repository'));
		}
	})
	.get('/git/status', async (c) => {
		try {
			using result = await c.get('fsStub').gitStatus();
			return c.json(result);
		} catch (error) {
			console.error('Git status error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, 'Failed to get git status');
		}
	})
	.post('/git/stage', zValidator('json', gitStageSchema), async (c) => {
		try {
			const { paths } = c.req.valid('json');
			using result = await c.get('fsStub').gitStage(paths);
			return c.json(result);
		} catch (error) {
			console.error('Git stage error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, 'Failed to stage files');
		}
	})
	.post('/git/unstage', zValidator('json', gitStageSchema), async (c) => {
		try {
			const { paths } = c.req.valid('json');
			using result = await c.get('fsStub').gitUnstage(paths);
			return c.json(result);
		} catch (error) {
			console.error('Git unstage error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, 'Failed to unstage files');
		}
	})
	.post('/git/stage-all', async (c) => {
		try {
			using result = await c.get('fsStub').gitStageAll();
			return c.json(result);
		} catch (error) {
			console.error('Git stage-all error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, 'Failed to stage all files');
		}
	})
	.post('/git/unstage-all', async (c) => {
		try {
			using result = await c.get('fsStub').gitUnstageAll();
			return c.json(result);
		} catch (error) {
			console.error('Git unstage-all error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, 'Failed to unstage all files');
		}
	})
	.post('/git/discard', zValidator('json', gitDiscardSchema), async (c) => {
		try {
			const { path } = c.req.valid('json');
			using result = await c.get('fsStub').gitDiscard(path);
			broadcastGitStatusChanged(c.get('projectId'), c.executionCtx);
			return c.json(result);
		} catch (error) {
			console.error('Git discard error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, 'Failed to discard changes');
		}
	})
	.post('/git/discard-all', async (c) => {
		try {
			using result = await c.get('fsStub').gitDiscardAll();
			broadcastGitStatusChanged(c.get('projectId'), c.executionCtx);
			return c.json(result);
		} catch (error) {
			console.error('Git discard-all error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, 'Failed to discard all changes');
		}
	})
	.post('/git/commit', zValidator('json', gitCommitSchema), async (c) => {
		try {
			const { message } = c.req.valid('json');
			const author = await getCommitAuthor(c.env, c.get('session').userId);
			using result = await c.get('fsStub').gitCommit(message, author);
			broadcastGitStatusChanged(c.get('projectId'), c.executionCtx);
			return c.json(result);
		} catch (error) {
			console.error('Git commit error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, messageOf(error, 'Failed to create commit'));
		}
	})
	.get('/git/log', zValidator('query', gitLogQuerySchema), async (c) => {
		try {
			const { reference, depth } = c.req.valid('query');
			using result = await c.get('fsStub').gitLog(reference ?? 'HEAD', depth ?? 50);
			return c.json(result);
		} catch (error) {
			console.error('Git log error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, 'Failed to get git log');
		}
	})
	.get('/git/log/graph', zValidator('query', gitGraphQuerySchema), async (c) => {
		try {
			const { maxCount } = c.req.valid('query');
			using result = await c.get('fsStub').gitLog('HEAD', maxCount ?? 100);
			return c.json(result);
		} catch (error) {
			console.error('Git graph error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, 'Failed to get git graph');
		}
	})
	.get('/git/branches', async (c) => {
		try {
			using result = await c.get('fsStub').gitBranches();
			return c.json(result);
		} catch (error) {
			console.error('Git branches error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, 'Failed to list branches');
		}
	})
	.post('/git/branch', zValidator('json', gitBranchSchema), async (c) => {
		try {
			const { name, checkout } = c.req.valid('json');
			using result = await c.get('fsStub').gitCreateBranch(name, checkout ?? false);
			return c.json(result);
		} catch (error) {
			console.error('Git create branch error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, messageOf(error, 'Failed to create branch'));
		}
	})
	.delete('/git/branch', zValidator('query', gitBranchNameQuerySchema), async (c) => {
		try {
			const { name } = c.req.valid('query');
			using result = await c.get('fsStub').gitDeleteBranch(name);
			return c.json(result);
		} catch (error) {
			console.error('Git delete branch error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, messageOf(error, 'Failed to delete branch'));
		}
	})
	.post('/git/branch/rename', zValidator('json', gitBranchRenameSchema), async (c) => {
		try {
			const { oldName, newName } = c.req.valid('json');
			using result = await c.get('fsStub').gitRenameBranch(oldName, newName);
			return c.json(result);
		} catch (error) {
			console.error('Git rename branch error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, messageOf(error, 'Failed to rename branch'));
		}
	})
	.post('/git/checkout', zValidator('json', gitCheckoutSchema), async (c) => {
		try {
			const { reference } = c.req.valid('json');
			using result = await c.get('fsStub').gitCheckout(reference);
			broadcastGitStatusChanged(c.get('projectId'), c.executionCtx);
			return c.json(result);
		} catch (error) {
			console.error('Git checkout error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, messageOf(error, 'Failed to checkout'));
		}
	})
	.post('/git/merge', zValidator('json', gitMergeSchema), async (c) => {
		try {
			const { branch } = c.req.valid('json');
			using result = await c.get('fsStub').gitMerge(branch);
			broadcastGitStatusChanged(c.get('projectId'), c.executionCtx);
			return c.json(result);
		} catch (error) {
			console.error('Git merge error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, messageOf(error, 'Failed to merge'));
		}
	})
	.get('/git/tags', async (c) => {
		try {
			using result = await c.get('fsStub').gitTags();
			return c.json(result);
		} catch (error) {
			console.error('Git tags error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, 'Failed to list tags');
		}
	})
	.post('/git/tag', zValidator('json', gitTagSchema), async (c) => {
		try {
			const { name, reference } = c.req.valid('json');
			using result = await c.get('fsStub').gitCreateTag(name, reference);
			return c.json(result);
		} catch (error) {
			console.error('Git create tag error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, messageOf(error, 'Failed to create tag'));
		}
	})
	.delete('/git/tag', zValidator('query', gitTagNameQuerySchema), async (c) => {
		try {
			const { name } = c.req.valid('query');
			using result = await c.get('fsStub').gitDeleteTag(name);
			return c.json(result);
		} catch (error) {
			console.error('Git delete tag error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, messageOf(error, 'Failed to delete tag'));
		}
	})
	.get('/git/diff', zValidator('query', gitDiffQuerySchema), async (c) => {
		try {
			const { path } = c.req.valid('query');
			using result = await c.get('fsStub').gitDiff(path);
			return c.json(result);
		} catch (error) {
			console.error('Git diff error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, 'Failed to get file diff');
		}
	})
	.get('/git/diff/commit', zValidator('query', gitCommitDiffQuerySchema), async (c) => {
		try {
			const { objectId } = c.req.valid('query');
			using result = await c.get('fsStub').gitDiffCommit(objectId);
			return c.json(result);
		} catch (error) {
			console.error('Git commit diff error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, 'Failed to get commit diff');
		}
	})
	.get('/git/diff/file', zValidator('query', gitFileDiffAtCommitQuerySchema), async (c) => {
		try {
			const { objectId, path } = c.req.valid('query');
			using result = await c.get('fsStub').gitDiffFile(objectId, path);
			return c.json(result);
		} catch (error) {
			console.error('Git file diff at commit error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, 'Failed to get file diff at commit');
		}
	});
