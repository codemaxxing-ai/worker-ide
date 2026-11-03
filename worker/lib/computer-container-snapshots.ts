import { WorkspaceContainerAPI } from '@cloudflare/computer/backends/container';
import { z } from 'zod';

import type { ProjectContainerAdmission } from './project-container-admission';
import type { ContainerLaunchSpec, ContainerRuntimeInfo } from '@cloudflare/computer/backends/container';

const SNAPSHOT_KEY = 'computer-container-snapshot';
const CAPTURE_ATTEMPT_KEY = 'computer-container-snapshot-attempt';
const AUTHENTICATION_KEY = 'computer-container-snapshot-key';
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const CAPTURE_INTERVAL = 24 * 60 * 60 * 1000;

const snapshotSchema = z.object({ id: z.string().min(1), size: z.number().finite().nonnegative() });
const metadataSchema = z.object({
	version: z.literal(1),
	owner: z.string().min(1),
	image: z.string().min(1),
	dependencies: z.string().min(1),
	createdAt: z.number().finite().nonnegative(),
	snapshot: snapshotSchema,
});
const recordSchema = metadataSchema.extend({ authentication: z.string().regex(/^[a-f\d]{64}$/) });

type SnapshotContainer = Pick<Container, 'running' | 'images' | 'inspect' | 'snapshotContainer'>;
type Launch = (specification: ContainerLaunchSpec) => Promise<ContainerRuntimeInfo>;

/** Handles never leave the owning project's storage or enter through caller input. */
export class ComputerContainerSnapshots {
	private generation = 0;

	constructor(
		private readonly storage: DurableObjectStorage['kv'],
		private readonly owner: string,
		private readonly container: () => SnapshotContainer | undefined,
		private readonly dependencies: () => Promise<string>,
		private readonly now: () => number = Date.now,
	) {}

	private specification(specification: ContainerLaunchSpec): ContainerLaunchSpec {
		if (specification.containerSnapshot !== undefined || specification.directorySnapshots !== undefined)
			throw new Error('Caller-provided container snapshots are not allowed');
		if (specification.name !== 'computer') throw new Error('Unknown project container image');
		return {
			name: 'computer',
			env: specification.env,
			enableInternet: specification.enableInternet,
			...(specification.instance === undefined ? {} : { instance: specification.instance }),
			...(specification.entrypoint === undefined ? {} : { entrypoint: specification.entrypoint }),
			labels: { ...specification.labels, project: this.owner },
		};
	}

	clear(): void {
		this.generation++;
		this.storage.delete(SNAPSHOT_KEY);
	}

	private async key(create: boolean): Promise<CryptoKey | undefined> {
		let bytes = this.storage.get<Uint8Array>(AUTHENTICATION_KEY);
		if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
			if (!create) return;
			bytes = crypto.getRandomValues(new Uint8Array(32));
			this.storage.put(AUTHENTICATION_KEY, bytes);
		}
		return crypto.subtle.importKey('raw', new Uint8Array(bytes), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
	}

	private payload(metadata: z.infer<typeof metadataSchema>): Uint8Array<ArrayBuffer> {
		return new Uint8Array(new TextEncoder().encode(JSON.stringify(metadataSchema.parse(metadata))));
	}

	private async record() {
		const value = this.storage.get<unknown>(SNAPSHOT_KEY);
		if (value === undefined) return;
		const parsed = recordSchema.safeParse(value);
		if (
			!parsed.success ||
			parsed.data.owner !== this.owner ||
			parsed.data.createdAt > this.now() ||
			this.now() - parsed.data.createdAt >= MAX_AGE
		) {
			this.clear();
			return;
		}
		const key = await this.key(false);
		const authentication = Uint8Array.from(parsed.data.authentication.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
		if (!key || !(await crypto.subtle.verify('HMAC', key, authentication, this.payload(parsed.data)))) {
			this.clear();
			return;
		}
		return parsed.data;
	}

	async start(specification: ContainerLaunchSpec, start: Launch, restart: Launch): Promise<ContainerRuntimeInfo> {
		const launch = this.specification(specification);
		const container = this.container();
		const saved = await this.record();
		if (!container || container.running || !saved) return start(launch);
		if (saved.image !== container.images.computer || saved.dependencies !== (await this.dependencies())) {
			this.clear();
			return start(launch);
		}
		try {
			return await start({ ...launch, containerSnapshot: { id: saved.snapshot.id } });
		} catch {
			// Startup has not dispatched a workspace command. Discard a missing or
			// unusable cache and let Computer establish a fresh runtime from the image.
			this.clear();
			console.warn('Container snapshot restore failed; starting the project image');
			return restart(launch);
		}
	}

	async restart(specification: ContainerLaunchSpec, restart: Launch): Promise<ContainerRuntimeInfo> {
		const launch = this.specification(specification);
		// Computer calls restart when startup health checks fail. Never retry a
		// snapshot that may itself be the reason the daemon could not start.
		this.clear();
		return restart(launch);
	}

	/** Called only after successful native setup, while the mutation queue is owned. */
	async capture(): Promise<void> {
		try {
			const container = this.container();
			const image = container?.images.computer;
			if (!container?.running || !image) return;
			const saved = await this.record();
			const dependencies = await this.dependencies();
			if (saved?.image === image && saved.dependencies === dependencies) return;
			if (saved) this.clear();
			const information = await container.inspect();
			// A live container may predate the current deployment. Do not associate
			// its filesystem with the new image, or accept another owner's label.
			if (information?.image !== image || information.labels.project !== this.owner) return;
			const now = this.now();
			const lastAttempt = z.number().finite().safeParse(this.storage.get<unknown>(CAPTURE_ATTEMPT_KEY));
			if (lastAttempt.success && now - lastAttempt.data < CAPTURE_INTERVAL) return;
			this.storage.put(CAPTURE_ATTEMPT_KEY, now);
			const generation = this.generation;
			const snapshot = snapshotSchema.parse(await container.snapshotContainer({ name: 'project-dependencies' }));
			if (generation !== this.generation || this.now() - now >= MAX_AGE) return;
			const metadata = metadataSchema.parse({ version: 1, owner: this.owner, image, dependencies, createdAt: now, snapshot });
			const key = await this.key(true);
			if (!key) return;
			const authentication = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, this.payload(metadata))), (byte) =>
				byte.toString(16).padStart(2, '0'),
			).join('');
			if (generation !== this.generation || this.now() - now >= MAX_AGE) return;
			this.storage.put(SNAPSHOT_KEY, { ...metadata, authentication });
			// A fixed creation deadline prevents restores from extending reuse forever.
			// Superseded platform snapshots expire 30 days after their last restore;
			// the platform currently exposes neither deletion nor a custom TTL.
		} catch {
			console.warn('Container dependency snapshot unavailable; continuing without a cache');
		}
	}
}

export class ComputerContainerHost extends WorkspaceContainerAPI {
	#snapshots: ComputerContainerSnapshots;
	#onLaunch: () => void;

	constructor(
		state: DurableObjectState,
		snapshots: ComputerContainerSnapshots,
		onLaunch: () => void,
		private readonly admission: Pick<ProjectContainerAdmission, 'launch'>,
	) {
		super(state);
		this.#snapshots = snapshots;
		this.#onLaunch = onLaunch;
	}

	override async start(specification: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> {
		const result = await this.admission.launch(() =>
			this.#snapshots.start(
				specification,
				(launch) => super.start(launch),
				(launch) => super.restart(launch),
			),
		);
		if (result.outcome !== 'adopted') this.#onLaunch();
		return result;
	}

	override async restart(specification: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> {
		const result = await this.admission.launch(() => this.#snapshots.restart(specification, (launch) => super.restart(launch)));
		this.#onLaunch();
		return result;
	}
}
