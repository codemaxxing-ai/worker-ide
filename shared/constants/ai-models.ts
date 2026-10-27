export type AIModelProvider = 'workers-ai';

export interface AIModelConfig<TId extends string = string> {
	id: TId;
	label: string;
	description?: string;
	provider: AIModelProvider;
	contextWindow: number;
	maxOutput: number;
}
export const AI_MODELS = [
	{
		id: '@cf/zai-org/glm-5.3',
		label: 'GLM 5.3',
		description: 'Flagship coding model from Z.ai',
		provider: 'workers-ai',
		contextWindow: 1_048_576,
		maxOutput: 16_384,
	},
	{
		id: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
		label: 'DeepSeek V4.1 Flash (1017)',
		description: 'Multimodal coding and reasoning model from DeepSeek',
		provider: 'workers-ai',
		contextWindow: 1_048_576,
		maxOutput: 16_384,
	},
	{
		id: '@cf/zai-org/glm-5.3-flash',
		label: 'GLM 5.3 Flash',
		description: 'Efficient multimodal coding model from Z.ai',
		provider: 'workers-ai',
		contextWindow: 1_048_576,
		maxOutput: 16_384,
	},
] as const satisfies readonly AIModelConfig[];

export type AIModelId = (typeof AI_MODELS)[number]['id'];

export const AI_MODEL_IDS: readonly AIModelId[] = AI_MODELS.map((model) => model.id);

// z.enum() requires a tuple type [string, ...string[]]
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Required for Zod enum tuple type
export const AI_MODEL_IDS_TUPLE = AI_MODEL_IDS as readonly [AIModelId, ...AIModelId[]];

export const DEFAULT_AI_MODEL: AIModelId = '@cf/zai-org/glm-5.3' satisfies AIModelId;
export const SUMMARIZATION_AI_MODEL: AIModelId = '@cf/zai-org/glm-5.3-flash' satisfies AIModelId;

export function getModelLabel(modelId: string): string {
	const model = AI_MODELS.find((m) => m.id === modelId);
	return model?.label ?? modelId;
}

export function getModelConfig(modelId: string): AIModelConfig | undefined {
	return AI_MODELS.find((m) => m.id === modelId);
}

export function getModelLimits(modelId: string): { contextWindow: number; maxOutput: number } {
	const config = getModelConfig(modelId);
	if (config) {
		return { contextWindow: config.contextWindow, maxOutput: config.maxOutput };
	}
	return { contextWindow: 200_000, maxOutput: 8192 };
}
