import { describe, expect, it } from 'vitest';

import { sessionIdSchema } from './validation';

describe('sessionIdSchema', () => {
	it('accepts valid lowercase alphanumeric IDs', () => {
		expect(sessionIdSchema.safeParse('11111111-1111-4111-8111-111111111111').success).toBe(true);
	});

	it('rejects paths with "../"', () => {
		expect(sessionIdSchema.safeParse('../etc').success).toBe(false);
	});

	it('rejects strings with spaces', () => {
		expect(sessionIdSchema.safeParse('abc 123').success).toBe(false);
	});

	it('rejects strings longer than 32 chars', () => {
		const longId = 'a'.repeat(33);
		expect(sessionIdSchema.safeParse(longId).success).toBe(false);
	});

	it('rejects uppercase chars', () => {
		expect(sessionIdSchema.safeParse('ABC123').success).toBe(false);
		expect(sessionIdSchema.safeParse('aBc123').success).toBe(false);
	});

	it('rejects empty strings', () => {
		expect(sessionIdSchema.safeParse('').success).toBe(false);
	});

	it('rejects special characters', () => {
		expect(sessionIdSchema.safeParse('abc-123').success).toBe(false);
		expect(sessionIdSchema.safeParse('abc_123').success).toBe(false);
	});
});
