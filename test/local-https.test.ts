import { createServer } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { localFetch } from './local-https';

describe('local test transport cancellation', () => {
	let origin: string;
	let requests = 0;
	const server = createServer((request, response) => {
		requests++;
		if (request.url === '/stream') {
			response.writeHead(200, { 'Content-Type': 'text/plain' });
			response.write('running');
			return;
		}
		response.end('ready');
	});

	beforeAll(async () => {
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Missing local test server address');
		origin = `http://127.0.0.1:${address.port}`;
	});

	afterAll(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});

	it('accepts a timed signal from the current isolated test environment', async () => {
		const response = await localFetch(new URL(origin), { signal: AbortSignal.timeout(30_000) });
		expect(await response.text()).toBe('ready');
	});

	it('rejects cancellation before dispatch without sending a request', async () => {
		const previousRequests = requests;
		const reason = new Error('Cancelled before dispatch');
		await expect(localFetch(origin, { signal: AbortSignal.abort(reason) })).rejects.toThrow(reason.message);
		expect(requests).toBe(previousRequests);
	});

	it('cancels an in-flight response body', async () => {
		const controller = new AbortController();
		const response = await localFetch(`${origin}/stream`, { signal: controller.signal });
		const body = response.text();
		controller.abort(new Error('Cancelled while streaming'));
		await expect(body).rejects.toThrow();
	});
});
