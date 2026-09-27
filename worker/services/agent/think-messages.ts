import { previewElementToPromptText } from '@shared/preview-element';

import type { ChatMessage, MessagePart } from '@shared/types';
import type { DynamicToolUIPart, UIMessage } from 'ai';

export function userMessageToUiMessage(message: ChatMessage): UIMessage {
	const parts: UIMessage['parts'] = [];
	for (const part of message.parts) {
		switch (part.type) {
			case 'text': {
				parts.push({ type: 'text', text: part.content });
				break;
			}
			case 'preview-element': {
				parts.push({ type: 'text', text: previewElementToPromptText(part) });
				break;
			}
			case 'image': {
				parts.push({ type: 'file', mediaType: part.mediaType, url: part.url, filename: part.name });
				break;
			}
			default: {
				break;
			}
		}
	}

	return { id: message.id, role: 'user', parts };
}

export function chatMessageToUiMessage(message: ChatMessage): UIMessage {
	if (message.role === 'user') return userMessageToUiMessage(message);

	const parts: UIMessage['parts'] = [];
	for (const part of message.parts) {
		switch (part.type) {
			case 'text': {
				parts.push({ type: 'text', text: part.content });
				break;
			}
			case 'reasoning': {
				parts.push({ type: 'reasoning', text: part.content });
				break;
			}
			case 'tool-call': {
				const result = message.parts.find((candidate) => candidate.type === 'tool-result' && candidate.toolCallId === part.toolCallId);
				parts.push(toolPartsToUiPart(part, result?.type === 'tool-result' ? result : undefined));
				break;
			}
			default: {
				break;
			}
		}
	}

	return { id: message.id, role: 'assistant', parts };
}

export function uiMessagesToChatMessages(messages: UIMessage[]): ChatMessage[] {
	return messages.map((message) => ({
		id: message.id,
		role: message.role === 'user' ? 'user' : 'assistant',
		parts: message.parts.flatMap((part) => uiPartToMessageParts(part)),
	}));
}

function uiPartToMessageParts(part: UIMessage['parts'][number]): MessagePart[] {
	if (part.type === 'text') {
		return [{ type: 'text', content: part.text }];
	}
	if (part.type === 'reasoning') {
		return [{ type: 'reasoning', content: part.text }];
	}
	if (part.type === 'file') {
		if (part.mediaType.startsWith('image/') && typeof part.url === 'string') {
			return [{ type: 'image', url: part.url, mediaType: part.mediaType, name: part.filename }];
		}
		return [{ type: 'text', content: `[Attachment: ${part.filename ?? part.mediaType}]` }];
	}
	return uiToolPartToMessageParts(part);
}

function uiToolPartToMessageParts(value: unknown): MessagePart[] {
	if (!isRecord(value) || typeof value.type !== 'string' || (!value.type.startsWith('tool-') && value.type !== 'dynamic-tool')) {
		return [];
	}

	const toolCallId = typeof value.toolCallId === 'string' ? value.toolCallId : crypto.randomUUID();
	const toolName = value.type === 'dynamic-tool' && typeof value.toolName === 'string' ? value.toolName : value.type.slice(5);
	const input = isRecord(value.input) ? value.input : {};
	const call: MessagePart = { type: 'tool-call', toolCallId, toolName, arguments: input };
	if (value.state !== 'output-available' && value.state !== 'output-error') {
		return [call];
	}
	if (value.state === 'output-error') {
		const output = typeof value.errorText === 'string' ? value.errorText : stringifyOutput(value.output);
		return [call, { type: 'tool-result', toolCallId, toolName, result: output, isError: true }];
	}
	return [call, { type: 'tool-result', toolCallId, toolName, result: stringifyOutput(value.output) }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringifyOutput(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value === undefined) return '';
	return JSON.stringify(value);
}

function toolPartsToUiPart(
	call: Extract<MessagePart, { type: 'tool-call' }>,
	result?: Extract<MessagePart, { type: 'tool-result' }>,
): DynamicToolUIPart {
	if (!result) {
		return {
			type: 'dynamic-tool',
			toolName: call.toolName,
			toolCallId: call.toolCallId,
			state: 'input-available',
			input: call.arguments,
		};
	}
	if (result.isError) {
		return {
			type: 'dynamic-tool',
			toolName: call.toolName,
			toolCallId: call.toolCallId,
			state: 'output-error',
			input: call.arguments,
			errorText: result.result,
		};
	}
	return {
		type: 'dynamic-tool',
		toolName: call.toolName,
		toolCallId: call.toolCallId,
		state: 'output-available',
		input: call.arguments,
		output: result.result,
	};
}
