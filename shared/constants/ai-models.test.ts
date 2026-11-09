import { describe, expect, it } from 'vitest';

import { DEFAULT_AI_MODEL, SUMMARIZATION_AI_MODEL, getModelConfig, getModelLimits } from './ai-models';
import { aiModelSchema } from '../validation/tools';

describe('Workers AI model catalog', () => {
	it.each([
		'@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
		'@cf/nvidia/nemotron-3-120b-a12b',
		'@cf/deepseek-ai/deepseek-v4-pro-0813',
		'@cf/deepseek-ai/deepseek-v4-flash-0731',
		'@cf/qwen/qwq-32b',
		'@cf/qwen/qwen3-30b-a3b-fp8',
		'@cf/moonshotai/kimi-k2.6',
		'@cf/moonshotai/kimi-k2.7-code',
		'@cf/zai-org/glm-5.2',
		'@cf/zai-org/glm-5.3-flash',
		'@cf/meta-llama/llama-2-7b-chat-hf-lora',
		'@cf/google/gemma-2b-it-lora',
		'@cf/google/gemma-7b-it-lora',
		'@cf/meta/llama-3.1-8b-instruct-fp8',
		'@cf/meta/llama-3.2-1b-instruct',
		'@cf/meta/llama-3.2-3b-instruct',
	])('rejects the model deprecated on November 20, 2026: %s', (modelId) => {
		expect(aiModelSchema.safeParse(modelId).success).toBe(false);
		expect(getModelConfig(modelId)).toBeUndefined();
	});

	it.each([
		['@cf/zai-org/glm-5.3', 1_048_576],
		['@cf/deepseek-ai/deepseek-v4.1-flash-1017', 1_048_576],
		['@cf/google/gemma-4-26b-a4b-it', 256_000],
		['@cf/qwen/qwen3.8-27b', 262_144],
	])('accepts the recommended replacement %s with its context budget', (modelId, contextWindow) => {
		expect(aiModelSchema.safeParse(modelId).success).toBe(true);
		expect(getModelLimits(modelId).contextWindow).toBe(contextWindow);
	});

	it('uses available models for coding and background generation', () => {
		expect(aiModelSchema.safeParse(DEFAULT_AI_MODEL).success).toBe(true);
		expect(aiModelSchema.safeParse(SUMMARIZATION_AI_MODEL).success).toBe(true);
	});
});
