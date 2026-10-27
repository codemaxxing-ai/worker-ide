import { SessionManager } from 'agents/experimental/memory/session';
import { MockLanguageModelV4 } from 'ai/test';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_AI_MODEL, getModelLimits } from '@shared/constants';

import {
	checkHarnessContext,
	configureHarnessSession,
	readHarnessTranscript,
	readSessionTranscript,
	withHarnessContextBudget,
} from './harness-session';

import type { LanguageModelV4 } from '@ai-sdk/provider';

describe('harness inference and transcript separation', () => {
	it('reads original rows rather than a compacted or hydrated inference window', async () => {
		const messages = [
			{
				id: 'original',
				metadata: { authorId: 'author', snapshotId: 'review', createdAt: 123 },
				role: 'user',
				parts: [
					{ type: 'text', text: 'Original instruction' },
					{ type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,aGVsbG8=' },
				],
			},
			{
				id: 'tool',
				role: 'assistant',
				parts: [
					{
						type: 'dynamic-tool',
						toolName: 'exec',
						toolCallId: 'execution',
						input: { command: 'pwd' },
						state: 'output-available',
						output: 'workspace',
					},
				],
			},
		];
		const result = await readHarnessTranscript({
			getHistoryRowStats: async () => messages.map((message) => ({ id: message.id, role: message.role, bytes: 100 })),
			// eslint-disable-next-line unicorn/no-null -- Session.getMessage returns null for missing rows.
			getMessage: async (id) => messages.find((message) => message.id === id) ?? null,
		});
		expect(result).toEqual(messages);
	});
	it('checks the final compacted provider input, including instructions and tool schemas', async () => {
		const generate = vi.fn<LanguageModelV4['doGenerate']>(async () => ({
			content: [],
			finishReason: { unified: 'stop', raw: undefined },
			usage: {
				inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
				outputTokens: { total: 1, text: 1, reasoning: 0 },
			},
			warnings: [],
		}));
		const model = withHarnessContextBudget(new MockLanguageModelV4({ doGenerate: generate }), DEFAULT_AI_MODEL);
		await model.doGenerate({ prompt: [{ role: 'system', content: 'Compacted history and instructions' }] });
		const oversized = 'x'.repeat(getModelLimits(DEFAULT_AI_MODEL).contextWindow * 4);
		await expect(model.doGenerate({ prompt: [{ role: 'system', content: oversized }] })).rejects.toThrow('context budget');
		await expect(
			model.doStream({
				prompt: [{ role: 'system', content: 'Instructions' }],
				tools: [{ type: 'function', name: 'large-tool', description: oversized, inputSchema: { type: 'object' } }],
			}),
		).rejects.toThrow('context budget');
		expect(generate).toHaveBeenCalledOnce();
	});
	it('reserves selected model output and headroom before requesting inference', () => {
		expect(checkHarnessContext(DEFAULT_AI_MODEL, [{ role: 'user', content: 'hello' }], 100)).toBeGreaterThan(100);
		expect(() => checkHarnessContext(DEFAULT_AI_MODEL, [], getModelLimits(DEFAULT_AI_MODEL).contextWindow)).toThrow('context budget');
	});
});

const summarize = vi.hoisted(() => vi.fn(async (_options: { abortSignal?: AbortSignal }) => ({ text: 'Earlier work was summarized.' })));
vi.mock('ai', async (importOriginal) => ({
	...(await importOriginal<typeof import('ai')>()),
	generateText: summarize,
}));

it('compacts initialization and long turns without changing the stored path, including after rehydration', async () => {
	await runInDurableObject(env.AgentRunner.getByName(crypto.randomUUID()), async (agent) => {
		const manager = SessionManager.create(agent);
		const info = manager.create('Compaction regression');
		const session = configureHarnessSession(manager.getSession(info.id), () => ({}));
		const originals = Array.from({ length: 14 }, (_, index) => ({
			id: `message-${index}`,
			role: index % 2 ? 'assistant' : 'user',
			parts: [{ type: 'text', text: `${index}: ${'history '.repeat(6000)}` }],
		}));
		for (const message of originals) await session.appendMessage(message);
		expect(summarize).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 4096, maxRetries: 2 }));
		const compactions = await session.getCompactions();
		expect(compactions.length).toBeGreaterThan(0);
		const inference = await session.getHistory();
		expect(inference.length).toBeLessThan(originals.length);
		expect(inference.slice(0, 3)).toEqual(originals.slice(0, 3));
		expect(inference.slice(-4)).toEqual(originals.slice(-4));
		expect(await readSessionTranscript(session)).toEqual(originals);
		const restored = configureHarnessSession(SessionManager.create(agent).getSession(info.id), () => ({}));
		const restoredHistory = await restored.getHistory();
		expect(restoredHistory.map(({ parts, role }) => ({ parts, role }))).toEqual(inference.map(({ parts, role }) => ({ parts, role })));
		expect(await readSessionTranscript(restored)).toEqual(originals);
		const controller = new AbortController();
		summarize.mockImplementationOnce(async (options) => {
			options.abortSignal?.throwIfAborted();
			throw new Error('Missing cancellation signal');
		});
		controller.abort();
		configureHarnessSession(restored, () => ({ abortSignal: controller.signal }));
		expect(await restored.compact()).toBeNull();
		expect(await readSessionTranscript(restored)).toEqual(originals);
	});
});
