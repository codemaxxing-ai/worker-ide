import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { agentRoutes } from './agent-routes';

import type { AppEnvironment } from '../types';

describe('agent submission admission limits', () => {
	const application = new Hono<AppEnvironment>().route('/', agentRoutes);
	const path = '/agent/sessions/11111111-1111-4111-8111-111111111111/submissions';
	it('rejects oversized input before parsing messages or waking a chat', async () => {
		const response = await application.request(path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ messageId: 'oversized', parts: [{ type: 'text', content: 'x'.repeat(16 * 1024 * 1024) }] }),
		});
		expect(response.status).toBe(413);
	});
	it('bounds the number of message parts before admission', async () => {
		const response = await application.request(path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ messageId: 'fragmented', parts: Array.from({ length: 257 }, () => ({ type: 'text', content: 'x' })) }),
		});
		expect(response.status).toBe(400);
	});
});
