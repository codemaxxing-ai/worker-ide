import { generateText, jsonSchema, Output } from 'ai';

import { SUMMARIZATION_AI_MODEL } from '@shared/constants';

import { createAdapter } from './workers-ai';
const TITLE_MODEL = SUMMARIZATION_AI_MODEL;

const MAX_TITLE_LENGTH = 100;
const FALLBACK_TRUNCATION_LENGTH = 50;
const FILE_REFERENCE_PATTERN = /@(\/[\w./-]+)/g;
const TRAILING_FILLER_WORDS_PATTERN = /\b(?:and|for|from|in|of|on|or|to|via|with|within)\s*$/i;

const SYSTEM_PROMPT =
	'You are a title generator. Read the user message below and respond with a short title (under 10 words) that captures what the user wants to do. Do NOT repeat these instructions. Do NOT describe what you are doing. Just output the title text.';

const titleOutput = Output.object({
	schema: jsonSchema<{ title: string }>({
		type: 'object',
		properties: {
			title: { type: 'string', description: 'The generated title text' },
		},
		required: ['title'],
	}),
});

export interface SessionTitleResult {
	title: string;
	isAiGenerated: boolean;
}

export interface SessionTitleContext {
	projectId?: string;
	organizationId?: string;
}

function getFileReferenceLabel(path: string): string {
	const segments = path.split('/');
	return segments.at(-1) || path;
}

function getFallbackTitleSourceText(userMessageText: string): string {
	let titleSourceText = userMessageText
		.replaceAll(FILE_REFERENCE_PATTERN, (_match, path: string) => ` ${getFileReferenceLabel(path)} `)
		.replaceAll(/\s+([,.;:!?])/g, '$1')
		.replaceAll(/\s+/g, ' ')
		.trim();

	while (TRAILING_FILLER_WORDS_PATTERN.test(titleSourceText)) {
		titleSourceText = titleSourceText.replace(TRAILING_FILLER_WORDS_PATTERN, '').trim();
	}

	return titleSourceText;
}

/**
 * Generate a short title for an AI agent session.
 * Falls back to truncating the user message on failure.
 */
export async function generateSessionTitle(userMessage: string, context?: SessionTitleContext): Promise<SessionTitleResult> {
	const fallbackTitleSourceText = getFallbackTitleSourceText(userMessage);
	const fallback = deriveFallbackTitle(userMessage);

	if (fallbackTitleSourceText.length === 0) {
		return { title: fallback, isAiGenerated: false };
	}

	try {
		const model = createAdapter(TITLE_MODEL, {
			generationType: 'title',
			projectId: context?.projectId,
			organizationId: context?.organizationId,
		});

		const { output } = await generateText({
			model,
			messages: [{ role: 'user' as const, content: userMessage.slice(0, 500) }],
			instructions: SYSTEM_PROMPT,
			maxOutputTokens: 500,
			output: titleOutput,
		});

		const title = output?.title.trim() ?? '';
		if (title.length === 0) {
			return { title: fallback, isAiGenerated: false };
		}

		const truncated = title.length > MAX_TITLE_LENGTH ? title.slice(0, MAX_TITLE_LENGTH).trim() : title;
		return { title: truncated, isAiGenerated: true };
	} catch {
		return { title: fallback, isAiGenerated: false };
	}
}
export function deriveFallbackTitle(userMessageText: string, maxLength = FALLBACK_TRUNCATION_LENGTH): string {
	const trimmed = getFallbackTitleSourceText(userMessageText);
	if (trimmed.length === 0) return 'New chat';
	return trimmed.length > maxLength ? trimmed.slice(0, maxLength).trim() + '...' : trimmed;
}
