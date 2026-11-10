import { isToolUIPart, getToolName, validateUIMessages } from 'ai';
import { z } from 'zod';

import { DEFAULT_AI_MODEL } from './constants';
import { previewElementToPromptText } from './preview-element';
import { aiModelSchema } from './validation';

import type { AgentMode, ToolMetadataInfo, ToolErrorInfo, UserMessagePart } from './types';
import type { UIMessage } from 'ai';

export const agentMessageMetadataSchema = z.object({
	createdAt: z.number().optional(),
	authorUserId: z.string().optional(),
	authorName: z.string().optional(),
	authorImage: z.string().optional(),
	submissionId: z.string().optional(),
	snapshotId: z.string().optional(),
	model: aiModelSchema.optional(),
	mode: z.enum(['code', 'plan', 'ask']).optional(),
});

export type AgentMessageMetadata = z.infer<typeof agentMessageMetadataSchema>;
export type AgentMessage = UIMessage<AgentMessageMetadata>;

/** Native messages are JSON across DO RPC; validate once at the HTTP boundary. */
export async function parseAgentHistoryPage(serialized: string): Promise<{ messages: AgentMessage[]; before?: string }> {
	const page = z.object({ messages: z.array(z.unknown()), before: z.string().optional() }).parse(JSON.parse(serialized));
	if (page.messages.length === 0) return { messages: [], before: page.before };
	return {
		messages: await validateUIMessages<AgentMessage>({ messages: page.messages, metadataSchema: agentMessageMetadataSchema.optional() }),
		before: page.before,
	};
}

export interface ChatConfiguration {
	projectId: string;
	organizationId?: string;
	sessionId: string;
	model: z.infer<typeof aiModelSchema>;
	mode: AgentMode;
	requestOriginContext?: { appOrigin: string; contentOrigin: string };
}

export interface QueuedAgentMessage {
	id: string;
	text: string;
	authorUserId?: string;
}

/** Only application metadata lives here; Think owns messages and streaming. */
export interface ChatState {
	configuration?: ChatConfiguration;
	activeSubmissionId?: string;
	status: 'idle' | 'running' | 'completed' | 'error' | 'aborted';
	queuedMessages: QueuedAgentMessage[];
	statusText?: string;
	error?: string;
	contextTokensUsed: number;
	toolMetadata: Record<string, ToolMetadataInfo>;
	toolErrors: Record<string, ToolErrorInfo>;
	debugLogId?: string;
	stopRequested: boolean;
	finalizing?: boolean;
}

export function initialChatState(): ChatState {
	return { status: 'idle', queuedMessages: [], contextTokensUsed: 0, toolMetadata: {}, toolErrors: {}, stopRequested: false };
}

export function createAgentUserMessage(id: string, parts: readonly UserMessagePart[], metadata: AgentMessageMetadata): AgentMessage {
	return {
		id,
		role: 'user',
		metadata,
		parts: parts.map((part) => {
			if (part.type === 'image') return { type: 'file', mediaType: part.mediaType, url: part.url, filename: part.name };
			return { type: 'text', text: part.type === 'preview-element' ? previewElementToPromptText(part) : part.content };
		}),
	};
}

export function agentMessageText(message: UIMessage): string {
	return message.parts
		.filter((part) => part.type === 'text')
		.map((part) => part.text)
		.join('\n');
}

export function pendingAgentQuestion(messages: readonly UIMessage[]): { question: string; options: string[] } | undefined {
	for (const message of messages.toReversed()) {
		if (message.role === 'user') return;
		for (const part of message.parts.toReversed()) {
			if (!isToolUIPart(part) || getToolName(part) !== 'user_question' || part.state !== 'output-available') continue;
			const result = z.object({ metadata: z.object({ question: z.string(), options: z.array(z.string()) }) }).safeParse(part.output);
			if (result.success) return result.data.metadata;
		}
	}
}

export const defaultAgentSettings = { model: DEFAULT_AI_MODEL, mode: 'code' } satisfies Pick<ChatConfiguration, 'model' | 'mode'>;

/** Native delegated-run progress carries bounded cumulative command output. */
export const agentToolProgressSchema = z.object({
	commandOutput: z.object({
		truncated: z.boolean(),
		executions: z
			.array(
				z.object({
					executionId: z.string(),
					stdout: z.string(),
					stderr: z.string(),
					stdoutBytes: z.number(),
					stderrBytes: z.number(),
					truncated: z.boolean(),
					final: z.boolean().optional(),
				}),
			)
			.max(32),
	}),
});
