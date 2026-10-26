import { createAI } from 'agents-models/models/ai-sdk';
import { wrapLanguageModel } from 'ai';
import { env } from 'cloudflare:workers';

import { withStreamStartTimeout, withStreamTimeout } from './stream-timeout';

import type { WorkersAIModelId } from 'agents-models/models/ai-sdk';
import type { LanguageModel } from 'ai';

const MAX_AFFINITY_COMPONENT_LENGTH = 80;
const MAX_REPEATED_CONTEXT_KEY_LENGTH = 512;

/**
 * Metadata context for AI Gateway tracking.
 */
export interface WorkersAiContext {
	/** The generation type label (e.g. 'agent', 'compaction', 'title', 'web_summarize'). */
	generationType: string;
	projectId?: string;
	userId?: string;
	organizationId?: string;
	sessionId?: string;
	repeatedContextKey?: string;
}

function normalizeAffinityComponent(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}

	const trimmedValue = value.trim();
	if (trimmedValue.length === 0) {
		return undefined;
	}

	const normalizedValue = trimmedValue.replaceAll(/[^a-zA-Z0-9:_-]+/g, '-').replaceAll(/^-+|-+$/g, '');
	if (normalizedValue.length === 0) {
		return undefined;
	}

	return normalizedValue.slice(0, MAX_AFFINITY_COMPONENT_LENGTH);
}

function hashRepeatedContextKey(value: string): string {
	let hashValue = 2_166_136_261;
	for (const character of value) {
		hashValue ^= character.codePointAt(0) ?? 0;
		hashValue = Math.imul(hashValue, 16_777_619);
	}

	return (hashValue >>> 0).toString(16).padStart(8, '0');
}

function getSessionAffinity(modelId: string, context: WorkersAiContext): string | undefined {
	const projectId = normalizeAffinityComponent(context.projectId) ?? 'global';
	const normalizedModelId = normalizeAffinityComponent(modelId) ?? 'model';

	if (context.generationType === 'agent') {
		const sessionId = normalizeAffinityComponent(context.sessionId);
		if (!sessionId) {
			return undefined;
		}

		return ['agent', projectId, sessionId, normalizedModelId].join(':');
	}

	if (context.generationType === 'compaction') {
		const repeatedContextKey = context.repeatedContextKey?.trim();
		if (!repeatedContextKey) {
			return undefined;
		}

		const repeatedContextHash = hashRepeatedContextKey(repeatedContextKey.slice(0, MAX_REPEATED_CONTEXT_KEY_LENGTH));
		return ['compaction', projectId, normalizedModelId, repeatedContextHash].join(':');
	}

	return undefined;
}

/**
 * Create a Vercel AI SDK v7 language model for Workers AI.
 *
 * @param modelId - Workers AI model ID
 * @param context - Metadata context for AI Gateway tracking
 */
export function createAdapter(modelId: WorkersAIModelId, context: WorkersAiContext): LanguageModel {
	const sessionAffinity = getSessionAffinity(modelId, context);

	const model = createAI({
		binding: env.AI,
		id: 'default',
		metadata: {
			app: 'worker-ide',
			type: context.generationType,
			project_id: context.projectId ?? '',
			org_id: context.organizationId ?? '',
			user_id: context.userId ?? '',
		},
	})(modelId, {
		headers: {
			'cf-aig-collect-log-payload': 'false',
		},
		sessionAffinity,
	});
	if (context.generationType !== 'agent') return model;
	return wrapLanguageModel({
		model,
		middleware: {
			specificationVersion: 'v4',
			wrapStream: async ({ doStream, params: parameters }) => {
				const result = await withStreamStartTimeout(doStream, 120_000, parameters.abortSignal);
				return { ...result, stream: withStreamTimeout(result.stream, 120_000, parameters.abortSignal) };
			},
		},
	});
}
