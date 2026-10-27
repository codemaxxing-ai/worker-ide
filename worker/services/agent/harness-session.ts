import { createCompactFunction } from 'agents/experimental/memory/utils';
import { generateText, validateUIMessages, wrapLanguageModel } from 'ai';

import { getModelLimits, SUMMARIZATION_AI_MODEL } from '@shared/constants';

import { estimateSessionTokens } from './context-pruner';
import { createAdapter } from './workers-ai';

import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { AIModelId } from '@shared/constants';
import type { Session, SessionMessage } from 'agents/experimental/memory/session';
import type { LanguageModel, UIMessage } from 'ai';

interface HarnessCompactionContext {
	projectId?: string;
	organizationId?: string;
	abortSignal?: AbortSignal;
}

export const HARNESS_COMPACTION_THRESHOLD = 100_000;
export const HARNESS_MAX_RETRIES = 2;

export function createHarnessCompactor(context: () => HarnessCompactionContext): Parameters<Session['onCompaction']>[0] {
	return createCompactFunction({
		summarize: async (prompt) => {
			const { abortSignal, ...generationContext } = context();
			const { text } = await generateText({
				abortSignal,
				model: createAdapter(SUMMARIZATION_AI_MODEL, { ...generationContext, generationType: 'compaction', repeatedContextKey: prompt }),
				prompt,
				maxOutputTokens: 4096,
				maxRetries: HARNESS_MAX_RETRIES,
			});
			return text;
		},
		protectHead: 3,
		tailTokenBudget: 32_000,
		minTailMessages: 4,
	});
}

export function configureHarnessSession(session: Session, context: () => HarnessCompactionContext): Session {
	return session.onCompaction(createHarnessCompactor(context)).compactAfter(HARNESS_COMPACTION_THRESHOLD, {
		tokenCounter: ({ messages, systemPrompt }) => estimateSessionTokens(messages, systemPrompt),
	});
}

export function harnessContextGuard(model: AIModelId) {
	return { proactive: { maxInputTokens: getHarnessInputBudget(model), headroom: 0.9, maxCompactions: 1 } };
}

function getHarnessInputBudget(model: AIModelId): number {
	const limits = getModelLimits(model);
	return Math.floor(limits.contextWindow * 0.9) - limits.maxOutput;
}

export function checkHarnessContext(model: AIModelId, messages: readonly { role: string; content: unknown }[], overhead: number): number {
	const used = Math.ceil(JSON.stringify(messages).length / 4) + overhead;
	if (used > getHarnessInputBudget(model))
		throw new Error('The required context exceeds the model context budget. Start a new session or reduce the input.');
	return used;
}

/** Check the final provider input after Think applies its proactive compaction. */
export function withHarnessContextBudget(model: LanguageModel, modelId: AIModelId): LanguageModelV4 {
	if (typeof model === 'string') throw new Error('The harness requires a configured provider model.');
	return wrapLanguageModel({
		model,
		middleware: {
			transformParams: async ({ params }) => {
				checkHarnessContext(modelId, params.prompt, Math.ceil(JSON.stringify(params.tools ?? []).length / 4));
				return params;
			},
		},
	});
}

/** Compaction overlays and bounded hydration are inference views, never UI history. */
export async function readHarnessTranscript(session: Pick<Session, 'getHistoryRowStats' | 'getMessage'>): Promise<UIMessage[]> {
	const messages = await readSessionTranscript(session);
	if (messages.length === 0) return [];
	return validateUIMessages({ messages });
}

export async function readSessionTranscript(session: Pick<Session, 'getHistoryRowStats' | 'getMessage'>): Promise<SessionMessage[]> {
	const rows = await session.getHistoryRowStats();
	if (!rows) throw new Error('The session provider cannot read the original transcript path.');
	const messages = [];
	for (const row of rows) {
		const message = await session.getMessage(row.id);
		if (!message) throw new Error(`The original transcript message ${row.id} is unavailable.`);
		messages.push(message);
	}
	return messages;
}
