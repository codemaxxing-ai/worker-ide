import { Sessions } from 'agents/sessions';
import { MockLanguageModelV4 } from 'ai/test';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_AI_MODEL, getModelLimits } from '@shared/constants';

import { checkHarnessContext, configureHarnessSession, readHarnessHistoryPage, withHarnessContextBudget } from './harness-session';
import { ProjectAgent } from '../../durable/project-agent';

import type { LanguageModelV4 } from '@ai-sdk/provider';

describe('harness inference and transcript separation', () => {
	it('returns an empty original transcript before the first submission', async () => {
		const getMessage = vi.fn(async () => {
			throw new Error('No message rows exist');
		});
		expect(await readHarnessHistoryPage({ getHistoryRowStats: async () => [], getMessage })).toEqual({ messages: [], before: undefined });
		expect(getMessage).not.toHaveBeenCalled();
	});
	it('reads original rows rather than a compacted or hydrated inference window', async () => {
		const messages = [
			{
				id: 'original',
				metadata: { authorUserId: 'author', snapshotId: 'review', createdAt: 123 },
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
		const result = await readHarnessHistoryPage({
			getHistoryRowStats: async () => messages.map((message) => ({ id: message.id, role: message.role, bytes: 100, tokenEstimate: 25 })),
			// eslint-disable-next-line unicorn/no-null -- Session.getMessage returns null for missing rows.
			getMessage: async (id) => messages.find((message) => message.id === id) ?? null,
		});
		expect(result.messages).toEqual(messages);
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
	vi.spyOn(ProjectAgent.prototype, 'addMcpServer').mockResolvedValue({ id: 'test', state: 'ready' });
	await runInDurableObject(
		env.ProjectAgent.getByName(`agent:${BigInt(`0x${env.DurableObjectFilesystem.newUniqueId()}`).toString(36)}`),
		async (agent) => {
			const manager = new Sessions();
			agent.lifecycle.use(manager);
			await manager.onStart();
			const session = configureHarnessSession(manager.session('compaction'), () => ({}));
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
			expect(inference.slice(0, 3)).toMatchObject(originals.slice(0, 3));
			expect(inference.slice(-2)).toMatchObject(originals.slice(-2));
			const originalPage = await readHarnessHistoryPage(session);
			expect(originalPage.messages).toEqual(originals);
			const restored = configureHarnessSession(manager.session('compaction'), () => ({}));
			const restoredHistory = await restored.getHistory();
			expect(restoredHistory.map(({ parts, role }) => ({ parts, role }))).toEqual(inference.map(({ parts, role }) => ({ parts, role })));
			expect(await readHarnessHistoryPage(restored)).toMatchObject({ messages: originals });
			const controller = new AbortController();
			summarize.mockImplementationOnce(async (options) => {
				options.abortSignal?.throwIfAborted();
				throw new Error('Missing cancellation signal');
			});
			controller.abort();
			configureHarnessSession(restored, () => ({ abortSignal: controller.signal }));
			await restored.compact().catch(() => {});
			expect(await readHarnessHistoryPage(restored)).toMatchObject({ messages: originals });
		},
	);
});

it('bounds original transcript pages by bytes and resumes from a stable message cursor', async () => {
	const messages = Array.from({ length: 80 }, (_, index) => ({
		id: `message-${index}`,
		role: 'user',
		parts: [{ type: 'text', text: String(index) }],
	}));
	const reader = {
		getHistoryRowStats: async () =>
			messages.map((message) => ({ id: message.id, role: message.role, bytes: 2 * 1024 * 1024, tokenEstimate: 1 })),
		getMessage: async (id: string) => {
			const message = messages.find((item) => item.id === id);
			if (!message) throw new Error('Missing row');
			return message;
		},
	};
	const newest = await readHarnessHistoryPage(reader);
	expect(newest.messages.map((message) => message.id)).toEqual(['message-78', 'message-79']);
	const earlier = await readHarnessHistoryPage(reader, newest.before);
	expect(earlier.messages.map((message) => message.id)).toEqual(['message-76', 'message-77']);
	await expect(readHarnessHistoryPage(reader, 'missing')).rejects.toThrow('cursor');
});
