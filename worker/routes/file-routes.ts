import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

import { HIDDEN_ENTRIES, isProtectedSystemFile } from '@shared/constants';
import { HttpErrorCode } from '@shared/http-errors';
import { createHmrUpdateForFile } from '@shared/types';
import { filePathSchema, writeFileSchema, mkdirSchema, moveFileSchema } from '@shared/validation';
import { fs } from '@worker/lib/project-fs';

import { agentRunnerNamespace, coordinatorNamespace } from '../lib/durable-object-namespaces';
import { httpError } from '../lib/http-error';
import { isHiddenPath, isPathSafe, isProtectedFile } from '../lib/path-utilities';
import { invalidateTsConfigCache } from '../services/transform-service';

import type { AppEnvironment } from '../types';
import type { FileInfo } from '@shared/types';

/**
 * File routes - all routes are prefixed with /api
 * These routes are chained for Hono RPC type inference.
 */
export const fileRoutes = new Hono<AppEnvironment>()
	// GET /api/files - List all files in the project
	.get('/files', async (c) => {
		const projectRoot = c.get('projectRoot');
		const files = await listFilesRecursive(projectRoot);
		return c.json({ files });
	})

	// GET /api/file?path=/src/main.ts - Read file content
	.get('/file', zValidator('query', z.object({ path: filePathSchema })), async (c) => {
		const projectRoot = c.get('projectRoot');
		const { path } = c.req.valid('query');

		if (!isPathSafe(projectRoot, path)) {
			throw httpError(HttpErrorCode.INVALID_PATH, 'Invalid path');
		}

		try {
			const content = await fs.readFile(`${projectRoot}${path}`, 'utf8');
			return c.json({ path, content });
		} catch {
			throw httpError(HttpErrorCode.FILE_NOT_FOUND, 'File not found');
		}
	})

	// PUT /api/file - Write file content
	.put('/file', zValidator('json', writeFileSchema), async (c) => {
		const projectRoot = c.get('projectRoot');
		const projectId = c.get('projectId');
		const { path, content } = c.req.valid('json');

		if (!isPathSafe(projectRoot, path)) {
			throw httpError(HttpErrorCode.INVALID_PATH, 'Invalid path');
		}

		if (isHiddenPath(path)) {
			throw httpError(HttpErrorCode.INVALID_PATH, 'Cannot modify internal system files');
		}

		if (isProtectedSystemFile(path)) {
			throw httpError(HttpErrorCode.VALIDATION_ERROR, 'This file is managed by the IDE and cannot be edited directly.');
		}

		await c.get('fsStub').writeFileContent(path, content);

		try {
			const agentStub = agentRunnerNamespace.getByName(`agent:${projectId}`);
			const syncResponse = await agentStub.fetch(
				new Request('http://agent/review/sync-path', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'x-partykit-room': `agent:${projectId}`,
					},
					body: JSON.stringify({ path }),
				}),
			);
			if (!syncResponse.ok) {
				const body = await syncResponse.text();
				throw new Error(body || 'Failed to sync review queue');
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to sync review queue';
			throw httpError(HttpErrorCode.INTERNAL_ERROR, message);
		}

		// Invalidate tsconfig cache when tsconfig.json is modified
		if (path === '/tsconfig.json' || path === '/tsconfig.app.json') {
			invalidateTsConfigCache(projectId, projectRoot);
		}

		// Trigger HMR update (CSS/JS get hot updates, other files trigger full reload)
		const coordinatorStub = coordinatorNamespace.getByName(`project:${projectId}`);
		await coordinatorStub.triggerUpdate(createHmrUpdateForFile(path));

		// Notify clients that git status may have changed
		await coordinatorStub.sendMessage({ type: 'git-status-changed' });

		return c.json({ success: true, path });
	})

	// DELETE /api/file?path=/src/old.ts - Delete file
	.delete('/file', zValidator('query', z.object({ path: filePathSchema })), async (c) => {
		const projectRoot = c.get('projectRoot');
		const { path } = c.req.valid('query');

		if (!isPathSafe(projectRoot, path)) {
			throw httpError(HttpErrorCode.INVALID_PATH, 'Invalid path');
		}

		if (isProtectedFile(path)) {
			throw httpError(HttpErrorCode.PROTECTED_FILE, 'Cannot delete protected file');
		}

		if (path === '/.git' || path.startsWith('/.git/')) {
			throw httpError(HttpErrorCode.PROTECTED_FILE, 'Cannot modify git repository internals');
		}

		if (isHiddenPath(path)) {
			throw httpError(HttpErrorCode.INVALID_PATH, 'Cannot modify internal system files');
		}

		try {
			await fs.rm(`${projectRoot}${path}`, { recursive: true, force: true });
			try {
				const agentStub = agentRunnerNamespace.getByName(`agent:${c.get('projectId')}`);
				const syncResponse = await agentStub.fetch(
					new Request('http://agent/review/sync-path', {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							'x-partykit-room': `agent:${c.get('projectId')}`,
						},
						body: JSON.stringify({ path }),
					}),
				);
				if (!syncResponse.ok) {
					const body = await syncResponse.text();
					throw new Error(body || 'Failed to sync review queue');
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : 'Failed to sync review queue';
				throw httpError(HttpErrorCode.INTERNAL_ERROR, message);
			}

			// Trigger HMR so the frontend refreshes the file list
			const projectId = c.get('projectId');
			const coordinatorStub = coordinatorNamespace.getByName(`project:${projectId}`);
			await coordinatorStub.triggerUpdate({
				type: 'full-reload',
				path,
				timestamp: Date.now(),
				targets: [],
			});

			// Notify clients that git status may have changed
			await coordinatorStub.sendMessage({ type: 'git-status-changed' });

			return c.json({ success: true });
		} catch {
			throw httpError(HttpErrorCode.INTERNAL_ERROR, 'Failed to delete file');
		}
	})

	// PATCH /api/file - Move/rename file
	.patch('/file', zValidator('json', moveFileSchema), async (c) => {
		const projectRoot = c.get('projectRoot');
		const projectId = c.get('projectId');
		const { from_path: fromPath, to_path: toPath } = c.req.valid('json');

		if (!isPathSafe(projectRoot, fromPath) || !isPathSafe(projectRoot, toPath)) {
			throw httpError(HttpErrorCode.INVALID_PATH, 'Invalid path');
		}

		if (isProtectedFile(fromPath)) {
			throw httpError(HttpErrorCode.PROTECTED_FILE, 'Cannot move protected file');
		}

		if (isHiddenPath(fromPath) || isHiddenPath(toPath)) {
			throw httpError(HttpErrorCode.INVALID_PATH, 'Cannot modify internal system files');
		}

		try {
			// Ensure destination directory exists
			const toDirectory = toPath.slice(0, toPath.lastIndexOf('/'));
			if (toDirectory) {
				await fs.mkdir(`${projectRoot}${toDirectory}`, { recursive: true });
			}

			await fs.rename(`${projectRoot}${fromPath}`, `${projectRoot}${toPath}`);
			try {
				const agentStub = agentRunnerNamespace.getByName(`agent:${projectId}`);
				const syncResponse = await agentStub.fetch(
					new Request('http://agent/review/move-path', {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							'x-partykit-room': `agent:${projectId}`,
						},
						body: JSON.stringify({ fromPath, toPath }),
					}),
				);
				if (!syncResponse.ok) {
					const body = await syncResponse.text();
					throw new Error(body || 'Failed to sync review queue');
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : 'Failed to sync review queue';
				throw httpError(HttpErrorCode.INTERNAL_ERROR, message);
			}

			// Trigger HMR so the frontend refreshes
			const coordinatorStub = coordinatorNamespace.getByName(`project:${projectId}`);
			await coordinatorStub.triggerUpdate({
				type: 'full-reload',
				path: toPath,
				timestamp: Date.now(),
				targets: [],
			});

			// Notify clients that git status may have changed
			await coordinatorStub.sendMessage({ type: 'git-status-changed' });

			return c.json({ success: true, from: fromPath, to: toPath });
		} catch {
			throw httpError(HttpErrorCode.INTERNAL_ERROR, 'Failed to move file');
		}
	})

	// POST /api/mkdir - Create directory
	.post('/mkdir', zValidator('json', mkdirSchema), async (c) => {
		const projectRoot = c.get('projectRoot');
		const { path } = c.req.valid('json');

		if (!isPathSafe(projectRoot, path)) {
			throw httpError(HttpErrorCode.INVALID_PATH, 'Invalid path');
		}

		await fs.mkdir(`${projectRoot}${path}`, { recursive: true });
		return c.json({ success: true });
	});
async function listFilesRecursive(directory: string, base = ''): Promise<FileInfo[]> {
	const files: FileInfo[] = [];
	try {
		const entries = await fs.readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			// Skip hidden entries (internal directories and files)
			if (HIDDEN_ENTRIES.has(entry.name)) continue;

			const relativePath = base ? `${base}/${entry.name}` : `/${entry.name}`;

			// Add the current entry
			files.push({
				path: relativePath,
				name: entry.name,
				isDirectory: entry.isDirectory(),
			});

			if (entry.isDirectory()) {
				files.push(...(await listFilesRecursive(`${directory}/${entry.name}`, relativePath)));
			}
		}
	} catch (error) {
		if (base === '') {
			console.error('listFilesRecursive error:', error);
		}
	}
	return files;
}

export type FileRoutes = typeof fileRoutes;
