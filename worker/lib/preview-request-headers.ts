/**
 * Shared request-header sanitization for preview requests.
 *
 * Preview requests are served on per-project content origins and their bodies are
 * ultimately handled by untrusted, generated application code (the React-SPA
 * worker isolate or the vinext server isolate). Any credential the browser
 * attaches to a preview request — most importantly the signed
 * `__Host-worker-ide-preview-access` grant cookie that authorizes access to a private
 * preview — must be removed before the request reaches that code, otherwise a
 * malicious app could read the token and exfiltrate it to bypass private-preview
 * access control.
 *
 * Private-preview access is validated up front in the top-level fetch handler,
 * so these headers are never needed once a request is dispatched to a runtime.
 */

/** Credential headers stripped before a preview request reaches app code. */
export const STRIPPED_PREVIEW_REQUEST_HEADERS = ['authorization', 'cookie', 'proxy-authorization'] as const;

/** Remove credential headers from `headers` in place (see {@link STRIPPED_PREVIEW_REQUEST_HEADERS}). */
export function stripPreviewRequestCredentials(headers: Headers): void {
	for (const name of STRIPPED_PREVIEW_REQUEST_HEADERS) {
		headers.delete(name);
	}
}
