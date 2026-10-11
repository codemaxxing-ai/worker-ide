import { HttpErrorCode } from '@shared/http-errors';

type HttpErrorCodeValue = (typeof HttpErrorCode)[keyof typeof HttpErrorCode];
interface ApiErrorResponse {
	readonly status: number;
	json(): Promise<unknown>;
}

const HTTP_ERROR_CODES = new Set<string>(Object.values(HttpErrorCode));

function isHttpErrorCode(value: string): value is HttpErrorCodeValue {
	return HTTP_ERROR_CODES.has(value);
}

/**
 * Typed API error with the server's error code and message.
 *
 * Use `error.code` for conditional error handling:
 * ```ts
 * if (error instanceof ApiError && error.code === 'RATE_LIMITED') {
 *   showRetryDialog();
 * }
 * ```
 */
export class ApiError extends Error {
	readonly code: HttpErrorCodeValue | undefined;
	readonly status: number;

	constructor(message: string, status: number, code?: HttpErrorCodeValue) {
		super(message);
		this.name = 'ApiError';
		this.code = code;
		this.status = status;
	}
}
interface ErrorResponseBody {
	error: string;
	code?: string;
}

/**
 * Attempt to parse a JSON `{ error, code }` body from a non-OK response.
 * Returns `undefined` if the body cannot be read or parsed.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && !!value;
}

async function parseErrorBody(response: ApiErrorResponse): Promise<ErrorResponseBody | undefined> {
	try {
		const body: unknown = await response.json();
		if (isRecord(body) && 'error' in body) {
			return {
				error: String(body.error),
				code: typeof body.code === 'string' ? body.code : undefined,
			};
		}
	} catch {
		// Body not parseable — fall through
	}
	return undefined;
}

/**
 * Parse the error body from a failed response and throw an `ApiError`.
 *
 * The server's error message is preferred over the fallback. The fallback
 * is only used when the response body cannot be parsed.
 *
 * @param response - The failed HTTP response (`!response.ok`)
 * @param fallback - Fallback error message if the body can't be parsed
 * @returns Never — always throws
 */
export async function throwApiError(response: ApiErrorResponse, fallback: string): Promise<never> {
	const body = await parseErrorBody(response);
	const message = body?.error || fallback;
	const code = body?.code && isHttpErrorCode(body.code) ? body.code : undefined;
	throw new ApiError(message, response.status, code);
}
