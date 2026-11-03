import { env, runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { ENTITLEMENT_ORG_MAX_RUNNING_CONTAINERS } from '@shared/entitlements';

import { organizationContainerCapacityNamespace } from './durable-object-namespaces';
import { ProjectContainerAdmission } from './project-container-admission';
import { generateProjectId } from './project-id';
import * as schema from '../db/auth-schema';

import type { ContainerRuntimeInfo } from '@cloudflare/computer/backends/container';

const database = drizzle(env.DB, { schema });
beforeAll(async () => {
	await env.DB.exec(
		`CREATE TABLE IF NOT EXISTS organization (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, logo TEXT, created_at INTEGER NOT NULL, metadata TEXT, plan TEXT NOT NULL DEFAULT 'free', deleted_at INTEGER, banned_at INTEGER)`,
	);
	await env.DB.exec(
		`CREATE TABLE IF NOT EXISTS project (id TEXT PRIMARY KEY, name TEXT NOT NULL, durable_object_hex_id TEXT NOT NULL, organization_id TEXT NOT NULL, preview_visibility TEXT NOT NULL DEFAULT 'private', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, deleted_via_type TEXT, deleted_via_id TEXT, banned_at INTEGER, last_activity_at INTEGER)`,
	);
	await env.DB.exec(
		`CREATE TABLE IF NOT EXISTS entitlement (id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, key TEXT NOT NULL, value_type TEXT NOT NULL, value TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
	);
	await env.DB.exec(
		`CREATE TABLE IF NOT EXISTS project_transfer (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_organization_id TEXT NOT NULL, target_organization_id TEXT NOT NULL, initiated_by_user_id TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER, resolved_by_user_id TEXT)`,
	);
});

async function organization(limit = 1) {
	const id = crypto.randomUUID();
	await database.insert(schema.organization).values({ id, name: id, slug: id, createdAt: new Date(), plan: 'free' });
	await database.insert(schema.entitlement).values({
		id: crypto.randomUUID(),
		scopeId: id,
		key: ENTITLEMENT_ORG_MAX_RUNNING_CONTAINERS,
		valueType: 'number',
		value: String(limit),
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	return id;
}

async function seedProject(state: DurableObjectState, organizationId: string) {
	const id = generateProjectId(state.id);
	await database
		.insert(schema.project)
		.values({ id, organizationId, name: id, durableObjectHexId: state.id.toString(), createdAt: new Date(), updatedAt: new Date() });
	return id;
}

function platform(state: DurableObjectState) {
	let exit = Promise.withResolvers<void>();
	const background: Promise<unknown>[] = [];
	const container: Container = {
		running: false,
		images: { computer: 'image' },
		start: vi.fn(() => {
			container.running = true;
			exit = Promise.withResolvers<void>();
		}),
		monitor: () => exit.promise,
		destroy: async () => {
			container.running = false;
			exit.resolve();
		},
		signal: () => {},
		getTcpPort: () => env.ASSETS,
		setInactivityTimeout: async () => {},
		interceptOutboundHttp: async () => {},
		interceptAllOutboundHttp: async () => {},
		interceptOutboundHttps: async () => {},
		inspect: async () => ({ image: 'image', labels: {} }),
		snapshotContainer: async () => ({ id: 'snapshot', size: 0 }),
		exec: async () => {
			throw new Error('No native command in this test');
		},
	};
	const context: DurableObjectState = {
		...state,
		id: state.id,
		storage: state.storage,
		container,
		waitUntil: (promise) => {
			background.push(promise);
		},
	};
	return { container, context, drain: () => Promise.all(background) };
}

describe('organization container admission', () => {
	it('serializes concurrent project admissions within an organization', async () => {
		const organizationId = await organization(3);
		const projects = await Promise.all(
			Array.from({ length: 8 }, async () => {
				return runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (project, state) => {
					const projectId = await seedProject(state, organizationId);
					const token = crypto.randomUUID();
					const admission = new ProjectContainerAdmission(state, env, projectId, async () => {});
					Reflect.set(admission, 'pendingToken', token);
					Reflect.set(project, 'admissionInstance', admission);
					return { projectId, token };
				});
			}),
		);
		const capacity = organizationContainerCapacityNamespace.getByName(`org:${organizationId}`);
		const results = await Promise.all(projects.map(({ projectId, token }) => capacity.reserve(organizationId, projectId, token)));
		expect(results.filter((result) => result.granted)).toHaveLength(3);
		expect(await capacity.status(organizationId)).toEqual({ currentRunningContainers: 3, maxRunningContainers: 3 });
		const separateOrganization = await organization();
		expect(await organizationContainerCapacityNamespace.getByName(`org:${separateOrganization}`).status(separateOrganization)).toEqual({
			currentRunningContainers: 0,
			maxRunningContainers: 1,
		});
		await Promise.all(projects.map(({ projectId, token }) => capacity.release(projectId, token)));
	});
	it('adopts a live container and reattaches monitoring after reconstruction without starting it', async () => {
		const organizationId = await organization(0);
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (project, state) => {
			const projectId = await seedProject(state, organizationId);
			const { container, context, drain } = platform(state);
			container.start();
			const admission = new ProjectContainerAdmission(context, env, projectId, async () => {});
			Reflect.set(project, 'admissionInstance', admission);
			const capacity = organizationContainerCapacityNamespace.getByName(`org:${organizationId}`);
			expect(await capacity.status(organizationId)).toEqual({ currentRunningContainers: 1, maxRunningContainers: 0 });
			await admission.restore();
			expect(container.start).toHaveBeenCalledOnce();
			await container.destroy();
			await drain();
			expect(await capacity.status(organizationId)).toEqual({ currentRunningContainers: 0, maxRunningContainers: 0 });
		});
	});
	it('counts launches, reuse and restarts once and releases on automatic exit', async () => {
		const organizationId = await organization();
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (project, state) => {
			const projectId = await seedProject(state, organizationId);
			const { container, context, drain } = platform(state);
			const onStopped = vi.fn(async () => {});
			const admission = new ProjectContainerAdmission(context, env, projectId, onStopped);
			Reflect.set(project, 'admissionInstance', admission);
			const start = async (): Promise<ContainerRuntimeInfo> => {
				if (!container.running) container.start();
				return { runtimeId: 'runtime', clientSecret: 'secret', outcome: 'launched' };
			};
			await admission.launch(start);
			const first = admission.inspect().reservation;
			await admission.launch(start);
			await admission.launch(async () => {
				await container.destroy();
				return start();
			});
			const capacity = organizationContainerCapacityNamespace.getByName(`org:${organizationId}`);
			if (!first) throw new Error('Missing reservation');
			await capacity.release(projectId, first.token);
			expect(await capacity.status(organizationId)).toEqual({ currentRunningContainers: 1, maxRunningContainers: 1 });
			await container.destroy();
			await expect
				.poll(async () => {
					const status = await capacity.status(organizationId);
					return status.currentRunningContainers;
				})
				.toBe(0);
			expect(onStopped).toHaveBeenCalled();
			await drain();
		});
	});
	it('blocks at zero before dispatch and frees a failed startup reservation', async () => {
		const organizationId = await organization(0);
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (project, state) => {
			const projectId = await seedProject(state, organizationId);
			const { context } = platform(state);
			const admission = new ProjectContainerAdmission(context, env, projectId, async () => {});
			Reflect.set(project, 'admissionInstance', admission);
			const operation = vi.fn(async (): Promise<never> => {
				throw new Error('Launch failed');
			});
			await expect(admission.launch(operation)).rejects.toThrow('CONTAINER_LIMIT_REACHED');
			expect(operation).not.toHaveBeenCalled();
			await database.update(schema.entitlement).set({ value: '1' }).where(eq(schema.entitlement.scopeId, organizationId));
			await expect(admission.launch(operation)).rejects.toThrow('Launch failed');
			const capacity = await organizationContainerCapacityNamespace.getByName(`org:${organizationId}`).status(organizationId);
			expect(capacity.currentRunningContainers).toBe(0);
		});
	});
	it('reconciles a missed exit before admitting a fresh launch under a reduced limit', async () => {
		const organizationId = await organization();
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (project, state) => {
			const projectId = await seedProject(state, organizationId);
			const { context, container, drain } = platform(state);
			const admission = new ProjectContainerAdmission(context, env, projectId, async () => {});
			Reflect.set(project, 'admissionInstance', admission);
			await admission.launch(async () => {
				container.start();
				return { runtimeId: 'one', clientSecret: 'secret', outcome: 'launched' };
			});
			// Simulate a lost monitor callback after the process exits.
			container.running = false;
			await database.update(schema.entitlement).set({ value: '0' }).where(eq(schema.entitlement.scopeId, organizationId));
			await expect(
				admission.launch(async () => {
					throw new Error('Must not dispatch');
				}),
			).rejects.toThrow('CONTAINER_LIMIT_REACHED');
			await container.destroy();
			await drain();
		});
	});
	it('reserves destination capacity before ownership changes and preserves source on denial', async () => {
		const sourceOrganization = await organization();
		const targetOrganization = await organization(0);
		await runInDurableObject(env.DurableObjectFilesystem.getByName(crypto.randomUUID()), async (project, state) => {
			const projectId = await seedProject(state, sourceOrganization);
			const { context, container, drain } = platform(state);
			const admission = new ProjectContainerAdmission(context, env, projectId, async () => {});
			Reflect.set(project, 'admissionInstance', admission);
			await admission.launch(async () => {
				container.start();
				return { runtimeId: 'one', clientSecret: 'secret', outcome: 'launched' };
			});
			const transferId = crypto.randomUUID();
			await database.insert(schema.projectTransfer).values({
				id: transferId,
				projectId,
				sourceOrganizationId: sourceOrganization,
				targetOrganizationId: targetOrganization,
				createdAt: new Date(),
				status: 'pending',
			});
			await expect(admission.transfer(transferId, 'user')).rejects.toThrow('CONTAINER_LIMIT_REACHED');
			const [unchanged] = await database.select().from(schema.project).where(eq(schema.project.id, projectId));
			expect(unchanged?.organizationId).toBe(sourceOrganization);
			await database.update(schema.entitlement).set({ value: '1' }).where(eq(schema.entitlement.scopeId, targetOrganization));
			await admission.transfer(transferId, 'user');
			const sourceCapacity = await organizationContainerCapacityNamespace.getByName(`org:${sourceOrganization}`).status(sourceOrganization);
			expect(sourceCapacity.currentRunningContainers).toBe(0);
			const targetCapacity = await organizationContainerCapacityNamespace.getByName(`org:${targetOrganization}`).status(targetOrganization);
			expect(targetCapacity.currentRunningContainers).toBe(1);
			await container.destroy();
			await drain();
		});
	});
});
