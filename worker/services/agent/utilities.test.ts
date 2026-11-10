import { describe, expect, it } from 'vitest';

import { isRecordObject, validateToolInput } from './utilities';

describe('isRecordObject', () => {
	it('returns true for plain objects', () => {
		expect(isRecordObject({})).toBe(true);
		expect(isRecordObject({ key: 'value' })).toBe(true);
	});

	it('returns false for arrays', () => {
		expect(isRecordObject([])).toBe(false);
		expect(isRecordObject([1, 2, 3])).toBe(false);
	});

	it('returns false for null and undefined', () => {
		// eslint-disable-next-line unicorn/no-null -- testing null behavior
		expect(isRecordObject(null)).toBe(false);
		expect(isRecordObject()).toBe(false);
	});

	it('returns false for primitives', () => {
		expect(isRecordObject('string')).toBe(false);
		expect(isRecordObject(42)).toBe(false);
		expect(isRecordObject(true)).toBe(false);
	});
});

describe('validateToolInput', () => {
	it('validates valid exec input', () => {
		const result = validateToolInput('exec', { command: 'ls -la' });
		expect(result.success).toBe(true);
	});

	it('rejects invalid exec input (missing command)', () => {
		const result = validateToolInput('exec', {});
		expect(result.success).toBe(false);
	});
});
