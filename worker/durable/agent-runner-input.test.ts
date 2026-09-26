import { describe, expect, it } from 'vitest';

import { MAX_IMAGE_ATTACHMENTS } from '@shared/constants';

import { getUserMessagePromptText, sanitizeSubmittedUserMessageParts } from './agent-runner-input';

describe('agent runner submitted message input', () => {
	it('merges text parts and drops malformed or external image data', () => {
		const parts = sanitizeSubmittedUserMessageParts([
			{ type: 'text', content: 'Hello ' },
			{ type: 'text', content: 'world' },
			{ type: 'image', url: 'https://example.com/image.png', mediaType: 'image/png' },
			{ type: 'image', url: 'data:image/png;base64,aGVsbG8=', mediaType: 'image/png', name: 'image.png' },
			{ type: 'unknown', content: 'discard' },
		]);

		expect(parts).toEqual([
			{ type: 'text', content: 'Hello world' },
			{ type: 'image', url: 'data:image/png;base64,aGVsbG8=', mediaType: 'image/png', name: 'image.png' },
		]);
		expect(getUserMessagePromptText(parts)).toBe('Hello world');
	});

	it('caps attached images before they reach the agent loop', () => {
		const images = Array.from({ length: MAX_IMAGE_ATTACHMENTS + 2 }, (_, index) => ({
			type: 'image',
			url: `data:image/png;base64,${index}`,
			mediaType: 'image/png',
		}));
		expect(sanitizeSubmittedUserMessageParts(images)).toHaveLength(MAX_IMAGE_ATTACHMENTS);
	});
});
