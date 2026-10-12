import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import { BINARY_EXTENSIONS, HIDDEN_ENTRIES } from '@shared/constants';
import { HttpErrorCode } from '@shared/http-errors';
import { dependenciesUpdateSchema, projectMetaSchema, visibilityBodySchema } from '@shared/validation';
import { fs } from '@worker/lib/project-fs';

import * as schema from '../db/auth-schema';
import { coordinatorNamespace, projectMetadataNamespace } from '../lib/durable-object-namespaces';
import { httpError } from '../lib/http-error';
import {
	readAssetSettings,
	readBindingsConfig,
	readDependencies,
	readProjectName,
	regenerateProtectedFiles,
	writeAssetSettings,
	writeBindingsConfig,
	writeDependencies,
	writeProjectName,
} from '../lib/protected-files';
import { resolveStorageQuotaForProject } from '../lib/storage-quota';
import { createZip } from '../lib/zip';

import type { AppEnvironment } from '../types';
export const projectRoutes = new Hono<AppEnvironment>()
	// GET /api/project/meta - Get project metadata (name + asset settings + bindings config from actual files)
	.get('/project/meta', async (c) => {
		const projectRoot = c.get('projectRoot');
		const projectId = c.get('projectId');
		const database = drizzle(c.env.DB, { schema });
		const projectRows = await database
			.select({
				organizationId: schema.project.organizationId,
				organizationSlug: schema.organization.slug,
			})
			.from(schema.project)
			.leftJoin(schema.organization, eq(schema.organization.id, schema.project.organizationId))
			.where(eq(schema.project.id, projectId))
			.limit(1);

		const project = projectRows[0];
		if (!project) {
			throw httpError(HttpErrorCode.NOT_FOUND, 'Project not found');
		}

		const memberRows = await database
			.select({ memberId: schema.member.id })
			.from(schema.member)
			.where(and(eq(schema.member.organizationId, project.organizationId), eq(schema.member.userId, c.get('session').userId)))
			.limit(1);

		const name = await readProjectName(projectRoot);
		const assetSettings = await readAssetSettings(projectRoot);
		const bindingsConfig = await readBindingsConfig(projectRoot);
		return c.json({
			name,
			assetSettings,
			bindingsConfig,
			organizationId: project.organizationId,
			organizationSlug: project.organizationSlug ?? undefined,
			permissions: {
				delete: memberRows.length > 0,
				updateVisibility: memberRows.length > 0,
			},
		});
	})

	// PUT /api/project/meta - Update project name and/or asset settings
	.put('/project/meta', async (c) => {
		const projectRoot = c.get('projectRoot');
		const body = await c.req.json();
		const parsed = projectMetaSchema.safeParse(body);
		if (!parsed.success) {
			throw httpError(HttpErrorCode.VALIDATION_ERROR, parsed.error.message);
		}

		// Update name in package.json if provided (creates the file if missing)
		if (parsed.data.name) {
			await writeProjectName(projectRoot, parsed.data.name);
		}

		// Update asset settings in wrangler.jsonc if provided
		if (parsed.data.assetSettings !== undefined) {
			await writeAssetSettings(projectRoot, parsed.data.assetSettings);
		}

		// Update bindings config in wrangler.jsonc if provided
		if (parsed.data.bindingsConfig !== undefined) {
			await writeBindingsConfig(projectRoot, parsed.data.bindingsConfig);
		}

		// Regenerate all protected files to keep them in sync
		if (parsed.data.name || parsed.data.assetSettings !== undefined || parsed.data.bindingsConfig !== undefined) {
			await regenerateProtectedFiles(projectRoot);
		}

		// Sync project name to D1 so dashboards and admin UI reflect the update
		if (parsed.data.name) {
			const projectId = c.get('projectId');
			const database = drizzle(c.env.DB, { schema });
			await database.update(schema.project).set({ name: parsed.data.name, updatedAt: new Date() }).where(eq(schema.project.id, projectId));
		}

		// Trigger full reload when metadata changes so the preview rebundles and WS clients sync
		if (parsed.data.name || parsed.data.assetSettings !== undefined || parsed.data.bindingsConfig !== undefined) {
			const projectId = c.get('projectId');
			const coordinatorStub = coordinatorNamespace.getByName(`project:${projectId}`);
			const assetSettings = await readAssetSettings(projectRoot);
			const bindingsConfig = await readBindingsConfig(projectRoot);

			if (parsed.data.assetSettings !== undefined || parsed.data.bindingsConfig !== undefined) {
				const domains: Array<'asset-settings' | 'bindings-config'> = [];
				if (parsed.data.assetSettings !== undefined) {
					domains.push('asset-settings');
				}
				if (parsed.data.bindingsConfig !== undefined) {
					domains.push('bindings-config');
				}

				await coordinatorStub.recordExternalChange({
					kind: 'wrangler-settings',
					path: '/wrangler.jsonc',
					timestamp: Date.now(),
					domains,
					assetSettings,
					bindingsConfig,
				});
			}

			await coordinatorStub.triggerUpdate({
				type: 'full-reload',
				path: parsed.data.name ? '/package.json' : '/wrangler.jsonc',
				timestamp: Date.now(),
				targets: [],
			});
		}

		const name = await readProjectName(projectRoot);
		const assetSettings = await readAssetSettings(projectRoot);
		const bindingsConfig = await readBindingsConfig(projectRoot);
		const projectId = c.get('projectId');
		const database = drizzle(c.env.DB, { schema });
		const projectRows = await database
			.select({
				organizationId: schema.project.organizationId,
				organizationSlug: schema.organization.slug,
			})
			.from(schema.project)
			.leftJoin(schema.organization, eq(schema.organization.id, schema.project.organizationId))
			.where(eq(schema.project.id, projectId))
			.limit(1);

		const project = projectRows[0];
		if (!project) {
			throw httpError(HttpErrorCode.NOT_FOUND, 'Project not found');
		}

		return c.json({
			name,
			assetSettings,
			bindingsConfig,
			organizationId: project.organizationId,
			organizationSlug: project.organizationSlug ?? undefined,
			permissions: {
				delete: true,
				updateVisibility: true,
			},
		});
	})

	// GET /api/dependencies - Read dependencies from package.json
	.get('/dependencies', async (c) => {
		const projectRoot = c.get('projectRoot');
		const dependencies = await readDependencies(projectRoot);
		return c.json({ dependencies });
	})

	// PUT /api/dependencies - Update dependencies in package.json
	.put('/dependencies', zValidator('json', dependenciesUpdateSchema), async (c) => {
		const projectRoot = c.get('projectRoot');
		const projectId = c.get('projectId');
		const { dependencies } = c.req.valid('json');
		await writeDependencies(projectRoot, dependencies);

		// Regenerate all protected files so vite.config.ts, devDependencies, etc. stay in sync
		await regenerateProtectedFiles(projectRoot);

		// Trigger full reload so the preview rebundles with new dependencies
		const coordinatorStub = coordinatorNamespace.getByName(`project:${projectId}`);
		await coordinatorStub.triggerUpdate({
			type: 'full-reload',
			path: '/package.json',
			timestamp: Date.now(),
			targets: [],
		});

		return c.json({ dependencies });
	})

	// GET /api/project/visibility - Get preview visibility
	.get('/project/visibility', async (c) => {
		const projectId = c.get('projectId');
		const database = drizzle(c.env.DB, { schema });
		const rows = await database
			.select({ previewVisibility: schema.project.previewVisibility })
			.from(schema.project)
			.where(eq(schema.project.id, projectId))
			.limit(1);
		const visibility = rows[0]?.previewVisibility ?? 'public';
		return c.json({ visibility });
	})

	// PUT /api/project/visibility - Update preview visibility
	.put('/project/visibility', zValidator('json', visibilityBodySchema), async (c) => {
		const projectId = c.get('projectId');
		const body = c.req.valid('json');
		const database = drizzle(c.env.DB, { schema });
		await database
			.update(schema.project)
			.set({ previewVisibility: body.visibility, updatedAt: new Date() })
			.where(eq(schema.project.id, projectId));
		return c.json({ visibility: body.visibility });
	})

	// GET /api/project/storage - Get storage usage and quota
	.get('/project/storage', async (c) => {
		const projectId = c.get('projectId');
		const bindingsConfig = await readBindingsConfig(c.get('projectRoot'));

		if (!bindingsConfig.storage) {
			return c.json({ usageBytes: 0, quotaBytes: 0, enabled: false });
		}

		const quotaBytes = await resolveStorageQuotaForProject(projectId, c.env.DB);
		const metadataStub = projectMetadataNamespace.getByName(`project:${projectId}`);
		const usageBytes = await metadataStub.getStorageUsageBytes();

		return c.json({ usageBytes, quotaBytes, enabled: true });
	})

	// GET /api/download - Download project as deployable zip
	.get('/download', async (c) => {
		const projectRoot = c.get('projectRoot');
		const projectFiles = await collectFilesForBundle(projectRoot);
		delete projectFiles['.initialized'];

		const projectName = await readProjectName(projectRoot);

		const zip = createZip(projectFiles);
		const safeName = projectName.replaceAll(/["\\\n\r]/g, '_');
		return new Response(zip, {
			headers: {
				'Content-Type': 'application/zip',
				'Content-Disposition': `attachment; filename="${safeName}.zip"`,
				'X-Content-Type-Options': 'nosniff',
				'Cache-Control': 'no-store',
			},
		});
	});
async function collectFilesForBundle(directory: string, base = ''): Promise<Record<string, string | Uint8Array>> {
	const files: Record<string, string | Uint8Array> = {};
	try {
		const entries = await fs.readdir(directory, { withFileTypes: true });
		const results = await Promise.all(
			entries
				.filter((entry: { name: string }) => !HIDDEN_ENTRIES.has(entry.name))
				.map(async (entry: { name: string; isDirectory: () => boolean }) => {
					const relativePath = base ? `${base}/${entry.name}` : entry.name;
					const fullPath = `${directory}/${entry.name}`;
					if (entry.isDirectory()) {
						return collectFilesForBundle(fullPath, relativePath);
					} else {
						const extension = entry.name.match(/\.[^.]+$/)?.[0]?.toLowerCase() ?? '';
						if (BINARY_EXTENSIONS.has(extension)) {
							const buffer = await fs.readFile(fullPath);
							return { [relativePath]: new Uint8Array(buffer) };
						}
						const content = await fs.readFile(fullPath, 'utf8');
						return { [relativePath]: content };
					}
				}),
		);
		for (const result of results) {
			Object.assign(files, result);
		}
	} catch (error) {
		if (base === '') {
			console.error('collectFilesForBundle error:', error);
		}
	}
	return files;
}

export type ProjectRoutes = typeof projectRoutes;
