import { HTTPException } from 'hono/http-exception';

import { DEFAULT_STATUS_CODES, type HttpErrorCode } from '@shared/http-errors';

import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * Throw an HTTP error with a typed error code and JSON body.
 *
 * The HTTP status code is inferred from `DEFAULT_STATUS_CODES[code]` but can
 * be overridden with the optional third parameter.
 *
 * @param code - Strongly typed error code (e.g. `HttpErrorCode.FILE_NOT_FOUND`)
 * @param message - Human-readable error message
 * @param status - Optional HTTP status code override
 *
 * @example
 * ```ts
 * // Status 404 inferred from HttpErrorCode.FILE_NOT_FOUND:
 * throw httpError(HttpErrorCode.FILE_NOT_FOUND, 'File not found: /src/app.ts');
 *
 * // Explicit status override:
 * throw httpError(HttpErrorCode.INTERNAL_ERROR, 'Unexpected failure', 503);
 * ```
 */
export function httpError(
	code: HttpErrorCode,
	message: string,
	status?: ContentfulStatusCode,
	options: { includeCode?: boolean } = {},
): HTTPException {
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- DEFAULT_STATUS_CODES values are valid HTTP status codes but typed as `number`
	const httpStatus = status ?? (DEFAULT_STATUS_CODES[code] as ContentfulStatusCode);
	return new HTTPException(httpStatus, {
		// Populate the Error's `message` too (not just the response body). Hono's
		// default error handler still uses `getResponse()` (the `res` below), so
		// route responses are unchanged — but `error.message` is now non-empty for
		// consumers that read it directly (e.g. the deploy workflow), instead of
		// silently surfacing as an empty string.
		message,
		res: Response.json(options.includeCode === false ? { error: message } : { error: message, code }, {
			status: httpStatus,
			headers: { 'Content-Type': 'application/json' },
		}),
	});
}
