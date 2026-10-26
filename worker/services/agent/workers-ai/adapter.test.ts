import { beforeEach, describe, expect, it, vi } from 'vitest';

type ModelSettings = {
	headers?: Record<string, string>;
	sessionAffinity?: string;
};

const { mockCreateAI, getLastModelSettings } = vi.hoisted(() => {
	let lastModelSettings: ModelSettings | undefined;

	const modelFactory = vi.fn((modelId: string, settings?: ModelSettings) => {
		lastModelSettings = settings;

		return {
			specificationVersion: 'v4',
			provider: 'cloudflare',
			modelId,
			doGenerate: vi.fn(),
			doStream: vi.fn(),
		};
	});

	return {
		getLastModelSettings: (): ModelSettings => lastModelSettings ?? {},
		mockCreateAI: vi.fn(() => modelFactory),
	};
});

vi.mock('cloudflare:workers', () => ({
	env: {
		AI: {},
	},
}));

vi.mock('agents-models/models/ai-sdk', () => ({
	createAI: mockCreateAI,
}));

const { createAdapter } = await import('./adapter');

describe('createAdapter', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('sets deterministic session affinity for agent requests', () => {
		createAdapter('@cf/meta/llama-3.1-8b-instruct', {
			generationType: 'agent',
			projectId: 'project 1',
			sessionId: 'session 1',
			organizationId: 'org-1',
			userId: 'user-1',
		});

		expect(mockCreateAI).toHaveBeenCalledWith({
			binding: expect.any(Object),
			id: 'default',
			metadata: { app: 'worker-ide', type: 'agent', project_id: 'project 1', org_id: 'org-1', user_id: 'user-1' },
		});

		expect(getLastModelSettings()).toMatchObject({
			sessionAffinity: 'agent:project-1:session-1:cf-meta-llama-3-1-8b-instruct',
			headers: {
				'cf-aig-collect-log-payload': 'false',
			},
		});
	});

	it('sets deterministic hashed session affinity for compaction requests', () => {
		createAdapter('@cf/meta/llama-3.1-8b-instruct', {
			generationType: 'compaction',
			projectId: 'project 1',
			repeatedContextKey: 'same prompt context',
		});
		const firstSettings = getLastModelSettings();

		createAdapter('@cf/meta/llama-3.1-8b-instruct', {
			generationType: 'compaction',
			projectId: 'project 1',
			repeatedContextKey: 'same prompt context',
		});
		const secondSettings = getLastModelSettings();

		createAdapter('@cf/meta/llama-3.1-8b-instruct', {
			generationType: 'compaction',
			projectId: 'project 1',
			repeatedContextKey: 'different prompt context',
		});
		const thirdSettings = getLastModelSettings();

		expect(firstSettings.sessionAffinity).toMatch(/^compaction:project-1:cf-meta-llama-3-1-8b-instruct:[0-9a-f]{8}$/);
		expect(secondSettings.sessionAffinity).toBe(firstSettings.sessionAffinity);
		expect(thirdSettings.sessionAffinity).not.toBe(firstSettings.sessionAffinity);
	});

	it('does not set session affinity for one-shot generations', () => {
		createAdapter('@cf/meta/llama-3.1-8b-instruct', {
			generationType: 'title',
			projectId: 'project 1',
		});

		expect(getLastModelSettings().sessionAffinity).toBeUndefined();
	});
});
