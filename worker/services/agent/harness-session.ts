import { createCompactFunction } from 'agents/sessions';
import { generateText, validateUIMessages, wrapLanguageModel } from 'ai';

import { agentMessageMetadataSchema } from '@shared/agent-chat';
import { getModelLimits, SUMMARIZATION_AI_MODEL } from '@shared/constants';

import { createAdapter } from './workers-ai';

import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { Session } from '@cloudflare/think';
import type { AgentMessage } from '@shared/agent-chat';
import type { AIModelId } from '@shared/constants';
import type { LanguageModel } from 'ai';

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
		keepRecentTokens: 32_000,
	});
}

interface CompactableSession {
	onCompaction(compactor: Parameters<Session['onCompaction']>[0]): unknown;
	compactAfter(threshold: number): unknown;
}
export function configureHarnessSession<T extends CompactableSession>(session: T, context: () => HarnessCompactionContext): T {
	session.onCompaction(createHarnessCompactor(context));
	session.compactAfter(HARNESS_COMPACTION_THRESHOLD);
	return session;
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

/** UI history reads original rows, bounded by both row count and payload bytes. */
export async function readHarnessHistoryPage(
	session: Pick<Session, 'getHistoryRowStats' | 'getMessage'>,
	before?: string,
	leafId?: string,
): Promise<{ messages: AgentMessage[]; before?: string }> {
	const rows = await session.getHistoryRowStats(leafId);
	const boundary = before ? rows.findIndex((row) => row.id === before) : rows.length;
	if (boundary < 0) throw new Error('History cursor not found');
	let first = boundary;
	let bytes = 0;
	while (first > 0 && boundary - first < 50) {
		const row = rows[first - 1];
		if (!row || (first < boundary && bytes + row.bytes > 4 * 1024 * 1024)) break;
		bytes += row.bytes;
		first--;
	}
	const messages = [];
	for (const row of rows.slice(first, boundary)) {
		const message = await session.getMessage(row.id);
		if (!message) throw new Error(`Transcript message ${row.id} is unavailable`);
		messages.push(message);
	}
	return {
		messages:
			messages.length === 0
				? []
				: await validateUIMessages<AgentMessage>({ messages, metadataSchema: agentMessageMetadataSchema.optional() }),
		before: first > 0 ? rows[first]?.id : undefined,
	};
}
