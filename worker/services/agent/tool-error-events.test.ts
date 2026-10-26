import { streamText, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ToolExecutionError } from '@shared/tool-errors';

import { toolErrorEvents } from './event-helpers';

import type { StreamEvent } from '@shared/agent-state';

describe('tool failures in step results', () => {
	it.each([
		{ toolName: 'missing_tool', input: '{}' },
		{ toolName: 'write', input: '{"path":42}' },
		{ toolName: 'write', input: '{"path":"/package.json"}' },
	])('finishes $toolName with $input exactly once', async ({ toolName, input }) => {
		const model = new MockLanguageModelV4({
			doStream: async () => ({
				stream: new ReadableStream({
					start(controller) {
						controller.enqueue({ type: 'tool-input-start', id: 'call', toolName });
						controller.enqueue({ type: 'tool-input-delta', id: 'call', delta: input });
						controller.enqueue({ type: 'tool-call', toolCallId: 'call', toolName, input });
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
		const events: StreamEvent[] = [];
		const result = streamText({
			model,
			prompt: 'Call the tool',
			tools: {
				write: tool({
					inputSchema: z.object({ path: z.string() }),
					execute: async () => {
						throw new ToolExecutionError('NOT_ALLOWED', 'Protected file');
					},
				}),
			},
			onStepFinish: (step) => {
				events.push(...toolErrorEvents(step.content));
			},
		});
		await result.consumeStream();
		expect(events).toEqual([
			expect.objectContaining({ type: 'tool-error', toolName, toolCallId: 'call' }),
			expect.objectContaining({ type: 'tool-call-end', toolName, toolCallId: 'call', isError: true }),
		]);
	});
});
