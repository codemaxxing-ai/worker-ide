import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockRoutePreviewRequest = vi.fn<(request: Request, ideOrigin: string) => Promise<Response>>();

vi.mock('../../preview-service', () => ({
	PreviewService: vi.fn(function () {
		return { routePreviewRequest: mockRoutePreviewRequest };
	}),
}));

// Mock cloudflare:workers env
vi.mock('cloudflare:workers', () => ({
	env: {
		APP_ORIGIN: 'https://codemaxxing.app',
		CONTENT_ORIGIN: 'https://codemaxxing.net',
		PREVIEW_SECRET: 'test-secret',
		AI: {
			toMarkdown: async (_files: Array<{ name: string; blob: Blob }>) => {
				return [{ data: '# Converted\n\nHello heading content', format: 'markdown' }];
			},
		},
	},
}));

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

const { execute } = await import('./preview-fetch');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { createMockContext, createMockSendEvent } from './test-helpers';

function makeResponse(body: string, options: { status?: number; contentType?: string; statusText?: string } = {}): Response {
	const { status = 200, contentType = 'text/html', statusText = 'OK' } = options;
	return new Response(body, {
		status,
		statusText,
		headers: { 'content-type': contentType },
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('preview_fetch', () => {
	beforeEach(() => {
		mockRoutePreviewRequest.mockReset();
	});

	it('dispatches through the shared runtime preview service', async () => {
		mockRoutePreviewRequest.mockResolvedValue(makeResponse('<html><body>Hello</body></html>'));
		const result = await execute({ path: '/' }, createMockSendEvent(), createMockContext({ projectId: 'project123' }));
		expect(mockRoutePreviewRequest).toHaveBeenCalledOnce();
		expect(mockRoutePreviewRequest.mock.calls[0][1]).toBe('https://codemaxxing.app');
		expect(result.output).toContain('200');
	});

	it('normalizes paths without leading slash', async () => {
		mockRoutePreviewRequest.mockResolvedValue(makeResponse('OK', { contentType: 'text/plain' }));

		await execute({ path: 'about' }, createMockSendEvent(), createMockContext({ projectId: 'project123' }));

		// The request should have been made with /about
		const requestArgument = mockRoutePreviewRequest.mock.calls[0][0];
		expect(new URL(requestArgument.url).pathname).toBe('/about');
	});

	// ── HTTP methods ─────────────────────────────────────────────────────

	it('defaults to GET method', async () => {
		mockRoutePreviewRequest.mockResolvedValue(makeResponse('OK', { contentType: 'text/plain' }));

		await execute({ path: '/' }, createMockSendEvent(), createMockContext({ projectId: 'project123' }));

		const requestArgument = mockRoutePreviewRequest.mock.calls[0][0];
		expect(requestArgument.method).toBe('GET');
	});

	it('supports POST method with body', async () => {
		mockRoutePreviewRequest.mockResolvedValue(
			makeResponse('{"id":1}', { contentType: 'application/json', status: 201, statusText: 'Created' }),
		);

		const result = await execute(
			{
				path: '/api/users',
				method: 'POST',
				body: '{"name":"Alice"}',
				headers: '{"Content-Type": "application/json"}',
			},
			createMockSendEvent(),
			createMockContext({ projectId: 'project123' }),
		);

		const requestArgument = mockRoutePreviewRequest.mock.calls[0][0];
		expect(requestArgument.method).toBe('POST');
		expect(result.output).toContain('201');
	});

	it('supports PUT method', async () => {
		mockRoutePreviewRequest.mockResolvedValue(makeResponse('updated', { contentType: 'text/plain' }));

		await execute(
			{ path: '/api/users/1', method: 'PUT', body: '{"name":"Bob"}' },
			createMockSendEvent(),
			createMockContext({ projectId: 'project123' }),
		);

		const requestArgument = mockRoutePreviewRequest.mock.calls[0][0];
		expect(requestArgument.method).toBe('PUT');
	});

	it('supports DELETE method', async () => {
		mockRoutePreviewRequest.mockResolvedValue(makeResponse('', { status: 204, statusText: 'No Content' }));

		const result = await execute(
			{ path: '/api/users/1', method: 'DELETE' },
			createMockSendEvent(),
			createMockContext({ projectId: 'project123' }),
		);

		const requestArgument = mockRoutePreviewRequest.mock.calls[0][0];
		expect(requestArgument.method).toBe('DELETE');
		expect(result.output).toContain('204');
	});

	it('rejects body on GET requests', async () => {
		await expect(
			execute({ path: '/', method: 'GET', body: 'some body' }, createMockSendEvent(), createMockContext({ projectId: 'project123' })),
		).rejects.toThrow('not supported for GET');
	});

	// ── Headers ──────────────────────────────────────────────────────────

	it('passes parsed headers to the request', async () => {
		mockRoutePreviewRequest.mockResolvedValue(makeResponse('ok', { contentType: 'text/plain' }));

		await execute(
			{ path: '/api/data', headers: '{"Authorization": "Bearer abc123", "Accept": "application/json"}' },
			createMockSendEvent(),
			createMockContext({ projectId: 'project123' }),
		);

		const requestArgument = mockRoutePreviewRequest.mock.calls[0][0];
		expect(requestArgument.headers.get('Authorization')).toBe('Bearer abc123');
		expect(requestArgument.headers.get('Accept')).toBe('application/json');
	});

	it('rejects invalid headers JSON', async () => {
		await expect(
			execute({ path: '/', headers: 'not-json' }, createMockSendEvent(), createMockContext({ projectId: 'project123' })),
		).rejects.toThrow('Invalid headers');
	});

	it('rejects array headers', async () => {
		await expect(
			execute({ path: '/', headers: '["a", "b"]' }, createMockSendEvent(), createMockContext({ projectId: 'project123' })),
		).rejects.toThrow('must be a JSON object');
	});

	// ── Format: raw ──────────────────────────────────────────────────────

	it('returns raw HTML by default', async () => {
		const html = '<html><body><h1>Hello</h1></body></html>';
		mockRoutePreviewRequest.mockResolvedValue(makeResponse(html));

		const result = await execute({ path: '/' }, createMockSendEvent(), createMockContext({ projectId: 'project123' }));

		expect(result.output).toContain(html);
	});

	// ── Format: markdown ─────────────────────────────────────────────────

	it('converts HTML to markdown when format=markdown', async () => {
		const html = '<html><body><h1>Hello</h1></body></html>';
		mockRoutePreviewRequest.mockResolvedValue(makeResponse(html));

		const result = await execute({ path: '/', format: 'markdown' }, createMockSendEvent(), createMockContext({ projectId: 'project123' }));

		expect(result.output).toContain('# Converted');
		expect(result.output).not.toContain('<html>');
	});

	it('skips markdown conversion for non-HTML content', async () => {
		const json = '{"data": "test"}';
		mockRoutePreviewRequest.mockResolvedValue(makeResponse(json, { contentType: 'application/json' }));

		const result = await execute(
			{ path: '/api/data', format: 'markdown' },
			createMockSendEvent(),
			createMockContext({ projectId: 'project123' }),
		);

		// Should still contain raw JSON since content-type is not HTML
		expect(result.output).toContain(json);
	});

	// ── Response metadata ────────────────────────────────────────────────

	it('includes status code and headers in output', async () => {
		mockRoutePreviewRequest.mockResolvedValue(
			new Response('Not Found', {
				status: 404,
				statusText: 'Not Found',
				headers: { 'content-type': 'text/plain', 'cache-control': 'no-cache' },
			}),
		);

		const result = await execute({ path: '/missing' }, createMockSendEvent(), createMockContext({ projectId: 'project123' }));

		expect(result.output).toContain('404 Not Found');
		expect(result.output).toContain('content-type: text/plain');
		expect(result.output).toContain('cache-control: no-cache');
		expect(result.title).toContain('404');
	});

	it('returns structured metadata', async () => {
		mockRoutePreviewRequest.mockResolvedValue(makeResponse('OK', { contentType: 'text/plain' }));

		const result = await execute({ path: '/' }, createMockSendEvent(), createMockContext({ projectId: 'project123' }));

		expect(result.metadata).toHaveProperty('path', '/');
		expect(result.metadata).toHaveProperty('method', 'GET');
		expect(result.metadata).toHaveProperty('status', 200);
		expect(result.metadata).toHaveProperty('contentType', 'text/plain');
	});

	// ── Response truncation ──────────────────────────────────────────────

	it('truncates large responses', async () => {
		const largeBody = 'x'.repeat(60_000);
		mockRoutePreviewRequest.mockResolvedValue(makeResponse(largeBody, { contentType: 'text/plain' }));

		const result = await execute({ path: '/' }, createMockSendEvent(), createMockContext({ projectId: 'project123' }));

		expect(result.output).toContain('(truncated)');
		expect(result.metadata).toHaveProperty('truncated', true);
	});

	// ── Error handling ───────────────────────────────────────────────────

	it('returns preview errors as results (not thrown)', async () => {
		mockRoutePreviewRequest.mockRejectedValue(new Error('Bundle failed: syntax error in src/main.tsx'));

		const result = await execute({ path: '/' }, createMockSendEvent(), createMockContext({ projectId: 'project123' }));

		expect(result.output).toContain('Request failed');
		expect(result.output).toContain('Bundle failed');
		expect(result.metadata).toHaveProperty('error');
		expect(result.title).toContain('Error');
	});

	// ── Missing path ─────────────────────────────────────────────────────

	it('throws error when path is empty', async () => {
		await expect(execute({ path: '' }, createMockSendEvent(), createMockContext({ projectId: 'project123' }))).rejects.toThrow('required');
	});

	// ── Status events ────────────────────────────────────────────────────

	it('sends status events', async () => {
		mockRoutePreviewRequest.mockResolvedValue(makeResponse('OK', { contentType: 'text/plain' }));
		const sendEvent = createMockSendEvent();

		await execute({ path: '/' }, sendEvent, createMockContext({ projectId: 'project123' }));

		const statusEvents = sendEvent.calls.filter(([type]) => type === 'status');
		expect(statusEvents.length).toBeGreaterThanOrEqual(1);
	});

	it('sends markdown conversion status event when format=markdown', async () => {
		mockRoutePreviewRequest.mockResolvedValue(makeResponse('<html><body>Hello</body></html>'));
		const sendEvent = createMockSendEvent();

		await execute({ path: '/', format: 'markdown' }, sendEvent, createMockContext({ projectId: 'project123' }));

		const statusMessages = sendEvent.calls.filter(([type]) => type === 'status').map(([, data]) => data.message);
		expect(statusMessages.some((message) => typeof message === 'string' && message.includes('markdown'))).toBe(true);
	});
});
