import { messagePartsToPromptText } from '@shared/chat-message-parts';
import { MAX_IMAGE_ATTACHMENTS } from '@shared/constants';
import { sanitizePreviewElementReference } from '@shared/preview-element';

import type { UserMessagePart } from '@shared/types';

function sanitizeSubmittedUserMessageParts(parts: unknown): UserMessagePart[] {
	if (!Array.isArray(parts)) {
		return [];
	}

	const sanitizedParts: UserMessagePart[] = [];
	let imageCount = 0;
	for (const part of parts) {
		if (!part || typeof part !== 'object' || Array.isArray(part) || !('type' in part) || typeof part.type !== 'string') {
			continue;
		}

		if (part.type === 'text' && 'content' in part && typeof part.content === 'string') {
			const previousPart = sanitizedParts.at(-1);
			if (previousPart?.type === 'text') {
				previousPart.content += part.content;
			} else {
				sanitizedParts.push({ type: 'text', content: part.content });
			}
			continue;
		}

		if (part.type === 'preview-element') {
			const sanitizedReference = sanitizePreviewElementReference(part);
			if (sanitizedReference) {
				sanitizedParts.push({ type: 'preview-element', ...sanitizedReference });
			}
			continue;
		}

		if (
			part.type === 'image' &&
			imageCount < MAX_IMAGE_ATTACHMENTS &&
			'url' in part &&
			typeof part.url === 'string' &&
			part.url.startsWith('data:') &&
			'mediaType' in part &&
			typeof part.mediaType === 'string'
		) {
			const name = 'name' in part && typeof part.name === 'string' ? part.name : undefined;
			sanitizedParts.push({ type: 'image', url: part.url, mediaType: part.mediaType, name });
			imageCount++;
		}
	}

	return sanitizedParts;
}

function getUserMessagePromptText(parts: readonly UserMessagePart[]): string {
	return messagePartsToPromptText(parts).trim();
}

export { getUserMessagePromptText, sanitizeSubmittedUserMessageParts };
