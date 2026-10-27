import { describe, expect, it, vi } from 'vitest';

import { ensureArtifactsRepo, mintArtifactsToken } from './artifacts-repo';

function createArtifactsFixture() {
	const metadata = {
		id: 'repository-id',
		name: 'project123',
		description: '',
		defaultBranch: 'main',
		createdAt: '2026-10-27T00:00:00Z',
		updatedAt: '2026-10-27T00:00:00Z',
		lastPushAt: '2026-10-27T00:00:00Z',
		source: '',
		readOnly: false,
		remote: 'https://artifacts.example/ide/project123',
	};
	const repository = {
		info: vi.fn<ArtifactsRepo['info']>().mockResolvedValue(metadata),
		createToken: vi.fn<ArtifactsRepo['createToken']>(),
		listTokens: vi.fn<ArtifactsRepo['listTokens']>(),
		revokeToken: vi.fn<ArtifactsRepo['revokeToken']>(),
		readBlob: vi.fn<ArtifactsRepo['readBlob']>(),
		readTree: vi.fn<ArtifactsRepo['readTree']>(),
		readCommit: vi.fn<ArtifactsRepo['readCommit']>(),
		readFile: vi.fn<ArtifactsRepo['readFile']>(),
		log: vi.fn<ArtifactsRepo['log']>(),
		fork: vi.fn<ArtifactsRepo['fork']>(),
		[Symbol.dispose]: vi.fn(),
	} satisfies ArtifactsRepo;
	const artifacts = {
		get: vi.fn<Artifacts['get']>().mockResolvedValue(repository),
		create: vi.fn<Artifacts['create']>().mockResolvedValue({ ...metadata, token: 'initial-token' }),
		import: vi.fn<Artifacts['import']>(),
		list: vi.fn<Artifacts['list']>(),
		delete: vi.fn<Artifacts['delete']>(),
	} satisfies Artifacts;
	return { environment: { ARTIFACTS: artifacts }, repository, artifacts, metadata };
}

describe('Artifacts repository capabilities', () => {
	it('reads metadata through info and releases the capability', async () => {
		const { environment, repository, metadata } = createArtifactsFixture();

		await expect(ensureArtifactsRepo(environment, metadata.name)).resolves.toEqual({ name: metadata.name, remote: metadata.remote });
		expect(repository.info).toHaveBeenCalledOnce();
		expect(repository[Symbol.dispose]).toHaveBeenCalledOnce();
	});

	it('releases a failed lookup before creating the repository', async () => {
		const { environment, repository, artifacts, metadata } = createArtifactsFixture();
		repository.info.mockRejectedValueOnce(new Error('Repository not found'));

		await expect(ensureArtifactsRepo(environment, metadata.name)).resolves.toEqual({ name: metadata.name, remote: metadata.remote });
		expect(artifacts.create).toHaveBeenCalledWith(metadata.name, { setDefaultBranch: 'main' });
		expect(repository[Symbol.dispose]).toHaveBeenCalledOnce();
	});

	it('re-reads metadata when another request wins repository creation', async () => {
		const { environment, repository, artifacts, metadata } = createArtifactsFixture();
		repository.info.mockRejectedValueOnce(new Error('Repository not found'));
		artifacts.create.mockRejectedValueOnce(new Error('Repository already exists'));

		await expect(ensureArtifactsRepo(environment, metadata.name)).resolves.toEqual({ name: metadata.name, remote: metadata.remote });
		expect(repository.info).toHaveBeenCalledTimes(2);
		expect(repository[Symbol.dispose]).toHaveBeenCalledTimes(2);
	});

	it('releases the capability after minting a repository token', async () => {
		const { environment, repository } = createArtifactsFixture();
		repository.createToken.mockResolvedValue({
			id: 'token-id',
			plaintext: 'secret?expires=1793145900',
			scope: 'read',
			expiresAt: '2026-10-27T00:05:00Z',
		});

		await expect(mintArtifactsToken(environment, 'project123', 'read')).resolves.toEqual({
			secret: 'secret',
			expiresAt: '2026-10-27T00:05:00Z',
		});
		expect(repository.createToken).toHaveBeenCalledWith('read', 300);
		expect(repository[Symbol.dispose]).toHaveBeenCalledOnce();
	});
});
