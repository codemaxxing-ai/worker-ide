import { streamText, tool, wrapLanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { withStreamTimeout } from './stream-timeout';

describe('provider stream inactivity', () => {
	afterEach(() => vi.useRealTimers());

	it('fails and cancels a provider stalled while generating tool arguments', async () => {
		vi.useFakeTimers();
		const cancel = vi.fn();
		const stream = new ReadableStream<string>({
			start(controller) {
				controller.enqueue('{"path":"/src/app.tsx","content":"');
			},
			cancel,
		});
		const reader = withStreamTimeout(stream, 120_000).getReader();
		const first = await reader.read();
		expect(first.value).toContain('/src/app.tsx');
		const failure = expect(reader.read()).rejects.toThrow('The model stopped responding');
		await vi.advanceTimersByTimeAsync(120_001);
		await failure;
		expect(cancel).toHaveBeenCalledOnce();
	});

	it('resets the deadline for each chunk and clears it after completion', async () => {
		vi.useFakeTimers();
		const { readable, writable } = new TransformStream<string>();
		const reader = withStreamTimeout(readable, 100).getReader();
		const writer = writable.getWriter();
		for (const chunk of ['first', 'second', 'third']) {
			const reading = reader.read();
			await vi.advanceTimersByTimeAsync(90);
			await writer.write(chunk);
			const next = await reading;
			expect(next.value).toBe(chunk);
		}
		const completion = reader.read();
		await writer.close();
		const completed = await completion;
		expect(completed.done).toBe(true);
		await vi.advanceTimersByTimeAsync(200);
		const finished = await reader.read();
		expect(finished.done).toBe(true);
	});

	it('propagates upstream failures and consumer cancellation', async () => {
		const failure = new Error('Provider disconnected');
		const failed = new ReadableStream({ start: (controller) => controller.error(failure) });
		await expect(withStreamTimeout(failed, 100).getReader().read()).rejects.toThrow(failure);
		const cancel = vi.fn();
		const reader = withStreamTimeout(new ReadableStream({ cancel }), 100).getReader();
		await reader.cancel('User stopped');
		expect(cancel).toHaveBeenCalledWith('User stopped');
	});

	it('allows a tool to run longer than the provider inactivity deadline', async () => {
		const model = new MockLanguageModelV3({
			doStream: async () => ({
				stream: new ReadableStream({
					start(controller) {
						controller.enqueue({ type: 'tool-call', toolCallId: 'call-1', toolName: 'exec', input: '{}' });
						controller.enqueue({
							type: 'finish',
							finishReason: { unified: 'tool-calls', raw: undefined },
							usage: {
								inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
								outputTokens: { total: 1, text: 1, reasoning: 0 },
							},
						});
						controller.close();
					},
				}),
				warnings: [],
			}),
		});
		const result = streamText({
			model: wrapLanguageModel({
				model,
				middleware: {
					specificationVersion: 'v3',
					wrapStream: async ({ doStream }) => {
						const response = await doStream();
						return { ...response, stream: withStreamTimeout(response.stream, 20) };
					},
				},
			}),
			prompt: 'Run a command',
			tools: {
				exec: tool({
					inputSchema: z.object({}),
					execute: async () => {
						await new Promise((resolve) => setTimeout(resolve, 60));
						return 'finished';
					},
				}),
			},
		});
		await result.consumeStream();
		const results = await result.toolResults;
		expect(results[0]?.output).toBe('finished');
	});
});
