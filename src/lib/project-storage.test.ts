import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_AI_MODEL } from '@shared/constants';

import { loadProjectUI } from './project-storage';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('persisted model selection', () => {
	it('falls back from GLM 5.3 Flash while preserving other UI preferences', () => {
		vi.stubGlobal('localStorage', {
			getItem: vi.fn(() => JSON.stringify({ ui: { selectedModel: '@cf/zai-org/glm-5.3-flash', sidebarVisible: false } })),
		});

		const state = loadProjectUI('project-1');

		expect(state.selectedModel).toBe(DEFAULT_AI_MODEL);
		expect(state.sidebarVisible).toBe(false);
	});

	it.each(['@cf/google/gemma-4-26b-a4b-it', '@cf/qwen/qwen3.8-27b'])('restores the replacement model %s', (modelId) => {
		vi.stubGlobal('localStorage', {
			getItem: vi.fn(() => JSON.stringify({ ui: { selectedModel: modelId } })),
		});

		expect(loadProjectUI('project-1').selectedModel).toBe(modelId);
	});
});
