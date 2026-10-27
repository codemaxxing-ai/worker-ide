import { APICallError } from '@ai-sdk/provider';
import { generateText, isStepCount, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { HARNESS_MAX_RETRIES } from './harness-session';

const usage = {
	inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
};
function providerError(statusCode: number) {
	return new APICallError({ message: 'Provider rejected request', url: 'https://provider.test', requestBodyValues: {}, statusCode });
}

describe('bounded SDK provider retries', () => {
	afterEach(() => vi.useRealTimers());
	it.each([429, 503])('recovers from transient %s after tool execution without replaying the tool', async (statusCode) => {
		vi.useFakeTimers();
		let requests = 0;
		const write = vi.fn(async () => 'saved');
		const model = new MockLanguageModelV4({
			doGenerate: async () => {
				requests++;
				if (requests === 2) throw providerError(statusCode);
				return {
					content:
						requests === 1
							? [{ type: 'tool-call', toolCallId: 'write-once', toolName: 'write', input: '{}' }]
							: [{ type: 'text', text: 'done' }],
					finishReason: { unified: requests === 1 ? 'tool-calls' : 'stop', raw: undefined },
					usage,
					warnings: [],
				};
			},
		});
		const result = generateText({
			model,
			prompt: 'write',
			tools: { write: tool({ inputSchema: z.object({}), execute: write }) },
			stopWhen: isStepCount(3),
			maxRetries: HARNESS_MAX_RETRIES,
		});
		await vi.runAllTimersAsync();
		const response = await result;
		expect(response.text).toBe('done');
		expect(requests).toBe(3);
		expect(write).toHaveBeenCalledOnce();
	});
	it.each([
		{ status: 503, requests: 3 },
		{ status: 400, requests: 1 },
	])('exhausts retries only for retryable status $status', async ({ status, requests }) => {
		vi.useFakeTimers();
		const generate = vi.fn(async () => {
			throw providerError(status);
		});
		const result = generateText({
			model: new MockLanguageModelV4({ doGenerate: generate }),
			prompt: 'hello',
			maxRetries: HARNESS_MAX_RETRIES,
		});
		const rejected = expect(result).rejects.toThrow();
		await vi.runAllTimersAsync();
		await rejected;
		expect(generate).toHaveBeenCalledTimes(requests);
	});
	it('cancels during backoff without starting another request', async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const generate = vi.fn(async () => {
			throw providerError(503);
		});
		const result = generateText({
			model: new MockLanguageModelV4({ doGenerate: generate }),
			prompt: 'hello',
			abortSignal: controller.signal,
			maxRetries: HARNESS_MAX_RETRIES,
		});
		const rejected = expect(result).rejects.toThrow();
		await vi.advanceTimersByTimeAsync(0);
		expect(generate).toHaveBeenCalledOnce();
		controller.abort();
		await rejected;
		await vi.runAllTimersAsync();
		expect(generate).toHaveBeenCalledOnce();
	});
});
