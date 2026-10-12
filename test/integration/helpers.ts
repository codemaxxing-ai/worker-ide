import { localFetch as fetch } from '../local-https';
export const BASE_URL = process.env.TEST_BASE_URL || 'https://localhost:3000';
export const TEST_ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
let sessionCookie: string;
export const createdProjectIds: string[] = [];

/**
 * Create a test session via the dev-only endpoint and cache the cookie.
 * Retries on failure to handle transient CI startup issues.
 */
export async function ensureTestSession(): Promise<string> {
	if (sessionCookie) return sessionCookie;

	const maxRetries = 5;
	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		const response = await fetch(`${BASE_URL}/__test/create-session`, {
			method: 'POST',
		});

		if (response.ok) {
			const setCookieHeader = response.headers.get('set-cookie');
			if (!setCookieHeader) {
				throw new Error('No session cookie returned from /__test/create-session');
			}
			sessionCookie = setCookieHeader.split(';')[0];
			return sessionCookie;
		}

		if (attempt < maxRetries) {
			await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
			continue;
		}

		const body = await response.text().catch(() => '');
		throw new Error(`Failed to create test session after ${maxRetries} attempts: ${response.status} ${response.statusText} — ${body}`);
	}

	throw new Error('Unreachable');
}
export async function authedFetch(url: string, options: RequestInit = {}): Promise<Response> {
	const cookie = await ensureTestSession();
	const headers = new Headers(options.headers);
	headers.set('Cookie', cookie);
	return fetch(url, { ...options, headers });
}

/**
 * Like authedFetch but retries transient failures (network errors or 5xx
 * responses) with exponential backoff. Deterministic 4xx responses are
 * returned immediately without retrying. Useful for mutation endpoints that
 * can intermittently fail under heavy parallel test load.
 */
export async function authedFetchWithRetry(url: string, options: RequestInit = {}, maxRetries = 4): Promise<Response> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			const response = await authedFetch(url, options);
			// Only retry transient server-side failures; 2xx/3xx/4xx are deterministic.
			if (response.status < 500) {
				return response;
			}
			lastError = new Error(`Request to ${url} failed: ${response.status} ${response.statusText}`);
		} catch (error) {
			lastError = error;
		}

		if (attempt < maxRetries) {
			await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
		}
	}

	throw lastError instanceof Error ? lastError : new Error(`Request to ${url} failed after ${maxRetries} attempts`);
}
export async function cleanupProjects(): Promise<void> {
	const cookie = sessionCookie;
	if (!cookie) return;

	for (const projectId of createdProjectIds) {
		try {
			await fetch(`${BASE_URL}/api/org/${TEST_ORGANIZATION_ID}/project/${projectId}`, {
				method: 'DELETE',
				headers: { Cookie: cookie },
			});
		} catch {
			// Ignore — project may already be deleted
		}
	}
	createdProjectIds.length = 0;

	try {
		await fetch(`${BASE_URL}/__test/cleanup`, { method: 'POST' });
	} catch {
		// Ignore — server may be down
	}
}
