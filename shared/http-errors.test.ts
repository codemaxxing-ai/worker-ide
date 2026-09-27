import { describe, expect, it } from 'vitest';

import { DEFAULT_STATUS_CODES, HttpErrorCode } from './http-errors';

describe('HttpErrorCode', () => {
	it('has all expected error codes', () => {
		expect(HttpErrorCode.FILE_NOT_FOUND).toBe('FILE_NOT_FOUND');
		expect(HttpErrorCode.INVALID_PATH).toBe('INVALID_PATH');
		expect(HttpErrorCode.PROTECTED_FILE).toBe('PROTECTED_FILE');
		expect(HttpErrorCode.GIT_OPERATION_FAILED).toBe('GIT_OPERATION_FAILED');
		expect(HttpErrorCode.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
		expect(HttpErrorCode.SESSION_NOT_FRESH).toBe('SESSION_NOT_FRESH');
		expect(HttpErrorCode.RATE_LIMITED).toBe('RATE_LIMITED');
		expect(HttpErrorCode.NOT_CONFIGURED).toBe('NOT_CONFIGURED');
		expect(HttpErrorCode.NOT_FOUND).toBe('NOT_FOUND');
		expect(HttpErrorCode.SESSION_NOT_FOUND).toBe('SESSION_NOT_FOUND');
		expect(HttpErrorCode.SNAPSHOT_NOT_FOUND).toBe('SNAPSHOT_NOT_FOUND');
		expect(HttpErrorCode.BUILD_FAILED).toBe('BUILD_FAILED');
		expect(HttpErrorCode.UPSTREAM_ERROR).toBe('UPSTREAM_ERROR');
		expect(HttpErrorCode.DATA_CORRUPTED).toBe('DATA_CORRUPTED');
		expect(HttpErrorCode.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
	});

	it('has string values equal to their keys', () => {
		for (const [key, value] of Object.entries(HttpErrorCode)) {
			expect(value).toBe(key);
		}
	});
});

describe('DEFAULT_STATUS_CODES', () => {
	it('maps every HttpErrorCode to a status code', () => {
		for (const code of Object.values(HttpErrorCode)) {
			expect(DEFAULT_STATUS_CODES[code]).toBeTypeOf('number');
			expect(DEFAULT_STATUS_CODES[code]).toBeGreaterThanOrEqual(400);
			expect(DEFAULT_STATUS_CODES[code]).toBeLessThan(600);
		}
	});

	it('maps specific codes to expected statuses', () => {
		expect(DEFAULT_STATUS_CODES[HttpErrorCode.FILE_NOT_FOUND]).toBe(404);
		expect(DEFAULT_STATUS_CODES[HttpErrorCode.INVALID_PATH]).toBe(400);
		expect(DEFAULT_STATUS_CODES[HttpErrorCode.PROTECTED_FILE]).toBe(403);
		expect(DEFAULT_STATUS_CODES[HttpErrorCode.GIT_OPERATION_FAILED]).toBe(500);
		expect(DEFAULT_STATUS_CODES[HttpErrorCode.VALIDATION_ERROR]).toBe(400);
		expect(DEFAULT_STATUS_CODES[HttpErrorCode.SESSION_NOT_FRESH]).toBe(403);
		expect(DEFAULT_STATUS_CODES[HttpErrorCode.RATE_LIMITED]).toBe(429);
		expect(DEFAULT_STATUS_CODES[HttpErrorCode.NOT_CONFIGURED]).toBe(500);
		expect(DEFAULT_STATUS_CODES[HttpErrorCode.NOT_FOUND]).toBe(404);
		expect(DEFAULT_STATUS_CODES[HttpErrorCode.SESSION_NOT_FOUND]).toBe(404);
		expect(DEFAULT_STATUS_CODES[HttpErrorCode.SNAPSHOT_NOT_FOUND]).toBe(404);
		expect(DEFAULT_STATUS_CODES[HttpErrorCode.BUILD_FAILED]).toBe(400);
		expect(DEFAULT_STATUS_CODES[HttpErrorCode.UPSTREAM_ERROR]).toBe(502);
		expect(DEFAULT_STATUS_CODES[HttpErrorCode.DATA_CORRUPTED]).toBe(422);
		expect(DEFAULT_STATUS_CODES[HttpErrorCode.INTERNAL_ERROR]).toBe(500);
	});
});
