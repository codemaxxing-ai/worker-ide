import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ToolFailureGuard } from '../tool-failure-guard';
import { createMockContext, createMockSendEvent } from './test-helpers';

import type { ToolFailureState } from '../tool-failure-guard';
import type { BrowserBinding } from '../types';
import type { StateBackend } from '@cloudflare/shell';
import type { Agent } from 'agents';

const mockReviewRun = vi.fn(async (_model: string, _input: unknown, _options: unknown) => ({
	answers: {
		complete: { type: 'noul', noul: 0.99 },
		needs_user: { type: 'noul', noul: 0.01 },
		unsupported_claims: { type: 'noul', noul: 0.01 },
	},
}));
const mockCreateExecuteRuntime = vi.fn();
const mockBrowserExecute = vi.fn(async ({ code }: { code: string }) => code);
const mockBrowserMarkdown = vi.fn(async (_input: { url?: string; html?: string }) => 'markdown');

vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<typeof import('cloudflare:workers')>()),
	tracing: undefined,
	env: {
		PREVIEW_SECRET: 'test-preview-secret',
		AI: { run: (...arguments_: unknown[]) => Reflect.apply(mockReviewRun, undefined, arguments_) },
	},
}));

vi.mock('@cloudflare/think/tools/execute', () => ({
	createExecuteRuntime: (...arguments_: Parameters<typeof mockCreateExecuteRuntime>) => {
		mockCreateExecuteRuntime(...arguments_);
		return { runtime: {}, connectors: [], tool: { description: 'codemode', inputSchema: z.object({}).loose(), execute: vi.fn() } };
	},
}));

vi.mock('@cloudflare/think/tools/browser', () => ({
	createBrowserTools: () => ({
		browser_markdown: { description: 'markdown', inputSchema: z.object({}).loose(), execute: mockBrowserMarkdown },
		browser_extract: { description: 'extract', inputSchema: z.object({}).loose(), execute: vi.fn(async () => 'extract') },
		browser_links: { description: 'links', inputSchema: z.object({}).loose(), execute: vi.fn(async () => 'links') },
		browser_scrape: { description: 'scrape', inputSchema: z.object({}).loose(), execute: vi.fn(async () => 'scrape') },
		browser_execute: { description: 'execute', inputSchema: z.object({}).loose(), execute: mockBrowserExecute },
	}),
}));

const { createServerTools } = await import('./index');

function createMockDurableObjectState(): DurableObjectState {
	return {} as DurableObjectState;
}

function createLoader(): WorkerLoader {
	return {
		get: vi.fn(() => ({ fetch: vi.fn() })),
		load: vi.fn(() => ({ fetch: vi.fn() })),
	};
}

function createBrowserFetcher(): BrowserBinding {
	return {
		fetch: vi.fn(async () => new Response('ok')),
	};
}

/** The `tools.*` set (incl. browser tools) passed into the most recent Code Mode runtime. */
function lastCodeModeTools(): Record<string, { execute?: unknown }> {
	const call = mockCreateExecuteRuntime.mock.calls.at(-1);
	if (!call) throw new Error('createExecuteRuntime was not called');
	return call[0].tools;
}

function contextOverrides(overrides?: Parameters<typeof createMockContext>[0]) {
	const context = createMockContext({
		projectId: 'project123',
		ctx: createMockDurableObjectState(),
		loader: createLoader(),
		browser: createBrowserFetcher(),
		requestOriginContext: { appOrigin: 'https://example.com', contentOrigin: 'https://content.example.net' },
		...overrides,
	});
	Reflect.set(context.fsStub, 'drainWorkspaceChanges', async () => Object.assign([], { [Symbol.dispose]: () => {} }));
	Reflect.set(context.fsStub, 'wsReadFile', async () => '[]');
	return context;
}

function createAgentWithMcpConnection(): { agent: Agent<Env, unknown>; waitForConnections: ReturnType<typeof vi.fn> } {
	const waitForConnections = vi.fn();
	const agent = {
		mcp: {
			waitForConnections,
			listServers: vi.fn(() => [{ id: 'cloudflare-docs' }]),
			mcpConnections: {
				'cloudflare-docs': { client: { callTool: vi.fn() }, tools: [] },
			},
		},
		runAgentTool: vi.fn(async () => ({ status: 'completed', runId: 'child-1', summary: 'Found the relevant files' })),
	} as unknown as Agent<Env, unknown>;
	return { agent, waitForConnections };
}

describe('createServerTools external guards', () => {
	beforeEach(() => {
		mockCreateExecuteRuntime.mockReset();
		mockReviewRun.mockClear();
		mockBrowserExecute.mockClear();
		mockBrowserMarkdown.mockClear();
	});

	it('exposes Computer tools and Code Mode with no-network sandbox, ctx, and state', async () => {
		const tools = await createServerTools(createMockSendEvent(), contextOverrides(), [], 'code');

		expect(tools).toHaveProperty('codemode');
		for (const name of ['read', 'ls', 'find', 'grep', 'write', 'edit', 'delete', 'exec']) expect(tools).toHaveProperty(name);
		// Other domain tools live inside Code Mode's tools.*.
		expect(tools).not.toHaveProperty('web_fetch');
		expect(tools).not.toHaveProperty('lint_fix');
		expect(mockCreateExecuteRuntime).toHaveBeenCalledWith(
			// eslint-disable-next-line unicorn/no-null -- codemode uses null to disable sandbox outbound network access
			expect.objectContaining({ globalOutbound: null, ctx: expect.anything(), state: expect.anything(), timeout: 360_000 }),
		);
	});

	it('passes SDK cancellation into domain tools before they emit events or write files', async () => {
		const sendEvent = createMockSendEvent();
		const tools = await createServerTools(sendEvent, contextOverrides(), [], 'code');
		const question = tools.user_question;
		if (!question?.execute) throw new Error('Missing question tool');
		const controller = new AbortController();
		controller.abort();
		await expect(
			question.execute({ question: 'Choose?' }, { toolCallId: 'cancelled-question', messages: [], abortSignal: controller.signal }),
		).rejects.toThrow();
		expect(sendEvent.calls).toEqual([]);
	});

	it('exposes dependency management directly alongside exec and inside Code Mode', async () => {
		const tools = await createServerTools(createMockSendEvent(), contextOverrides(), [], 'code');
		for (const name of ['dependencies_list', 'dependencies_update']) {
			expect(tools[name]?.execute).toBeTypeOf('function');
			expect(lastCodeModeTools()[name]?.execute).toBeTypeOf('function');
		}
	});

	it('reviews observed nested Code Mode results instead of trusting the draft summary', async () => {
		const testContext = contextOverrides({
			readCompletionReviewContext: async () => ({
				messages: [{ id: 'request', role: 'user', parts: [{ type: 'text', content: 'Add a cube' }] }],
				changedPaths: ['/src/app.tsx'],
				observations: [],
				todos: [],
				revision: 0,
				incomplete: false,
			}),
		});
		Reflect.set(testContext.fsStub, 'computerExec', async () => ({
			backend: 'container',
			exitCode: 1,
			stdout: 'window is not defined',
			stderr: '',
			[Symbol.dispose]: () => {},
		}));
		const tools = await createServerTools(createMockSendEvent(), testContext, [], 'code');
		const nested = lastCodeModeTools();
		expect(tools.completion_review?.execute).toBeTypeOf('function');
		expect(nested.completion_review?.execute).toBeTypeOf('function');
		const list = nested.dependencies_list?.execute;
		if (typeof list !== 'function') throw new Error('Missing nested dependencies tool');
		await list({}, { toolCallId: 'nested-list', messages: [] });
		const execute = nested.exec?.execute;
		if (typeof execute !== 'function') throw new Error('Missing nested exec tool');
		await execute({ command: 'bun run test', backend: 'container' }, { toolCallId: 'nested-test', messages: [] });
		const review = tools.completion_review;
		if (!review?.execute) throw new Error('Missing completion review');
		const nestedReview = nested.completion_review?.execute;
		if (typeof nestedReview !== 'function') throw new Error('Missing nested completion review');
		const result = await nestedReview({ draft_summary: 'Done' }, { toolCallId: 'review', messages: [] });
		expect(JSON.parse(result).recommendation).toBe('continue');
		expect(mockReviewRun).toHaveBeenCalledWith(
			'@cf/cloudflare/clef-flash',
			expect.objectContaining({ state: expect.stringContaining('dependencies_list') }),
			expect.objectContaining({
				signal: expect.any(AbortSignal),
				extraHeaders: { 'cf-aig-collect-log-payload': 'false' },
				gateway: expect.objectContaining({
					id: 'default',
					retries: { maxAttempts: 1 },
					metadata: expect.objectContaining({ type: 'completion_review' }),
				}),
			}),
		);
		expect(mockReviewRun.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ state: expect.stringContaining('window is not defined') }));
		Reflect.set(testContext.fsStub, 'wsReadFile', async () => 'malformed TODO data');
		const unavailable = await review.execute({ draft_summary: 'Done' }, { toolCallId: 'missing-evidence', messages: [] });
		expect(unavailable).toContain('"recommendation":"unknown"');
		expect(unavailable).toContain('tool:2');
		expect(mockReviewRun).toHaveBeenCalledOnce();
	});

	it.each(['plan', 'ask'])('does not expose completion review in %s mode', async (mode) => {
		const tools = await createServerTools(createMockSendEvent(), contextOverrides(), [], mode === 'plan' ? 'plan' : 'ask');
		expect(tools).not.toHaveProperty('completion_review');
		expect(lastCodeModeTools()).not.toHaveProperty('completion_review');
	});

	it.each(['plan', 'ask'])('stops repeated forbidden state writes in %s mode before executing a mutation', async (mode) => {
		let failureState: ToolFailureState = { submissionId: 'submission', count: 0, seen: [] };
		const failureGuard = new ToolFailureGuard(
			() => failureState,
			(state) => {
				failureState = state;
			},
		);
		const context = contextOverrides({ failureGuard });
		const write = vi.fn(async () => {});
		Reflect.set(context.fsStub, 'wsWriteFile', write);
		await createServerTools(createMockSendEvent(), context, [], mode === 'plan' ? 'plan' : 'ask');
		const call = mockCreateExecuteRuntime.mock.calls.at(-1);
		if (!call) throw new Error('Missing CodeMode runtime');
		const backend: StateBackend = call[0].state;
		for (let index = 0; index < 3; index++) await expect(backend.writeFile('/source.txt', 'blocked')).rejects.toThrow('read-only');
		expect(failureState.count).toBe(3);
		expect(failureGuard.controller.signal.aborted).toBe(true);
		expect(write).not.toHaveBeenCalled();
	});

	it('does not expose primary completion review in sub-agents', async () => {
		const tools = await createServerTools(createMockSendEvent(), contextOverrides({ isSubAgent: true }), [], 'code');
		expect(tools).not.toHaveProperty('completion_review');
		expect(lastCodeModeTools()).not.toHaveProperty('completion_review');
	});

	it('keeps sub-agent calls direct so retained runs receive their parent tool call ID', async () => {
		const { agent } = createAgentWithMcpConnection();
		const tools = await createServerTools(createMockSendEvent(), contextOverrides({ agentReference: agent }), [], 'code');
		expect(lastCodeModeTools()).not.toHaveProperty('sub_agent');
		const subAgent = tools.sub_agent;
		if (!subAgent?.execute) throw new Error('Missing sub-agent tool');
		await subAgent.execute({ prompt: 'Find the relevant files' }, { toolCallId: 'parent-call', messages: [] });
		expect(agent.runAgentTool).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				runId: 'agent-tool:parent-call',
				parentToolCallId: 'parent-call',
				input: expect.objectContaining({ parentToolCallId: 'parent-call' }),
			}),
		);
	});

	it.each(['code', 'plan', 'ask'])('keeps user questions directly available outside Code Mode in %s mode', async (mode) => {
		if (mode !== 'code' && mode !== 'plan' && mode !== 'ask') throw new Error('Invalid test mode');
		const tools = await createServerTools(createMockSendEvent(), contextOverrides(), [], mode);
		expect(tools.user_question?.execute).toBeTypeOf('function');
		expect(lastCodeModeTools()).not.toHaveProperty('user_question');
	});

	it.each(['plan', 'ask'])('keeps dependency updates unavailable in %s mode on both surfaces', async (mode) => {
		if (mode !== 'plan' && mode !== 'ask') throw new Error('Invalid test mode');
		const tools = await createServerTools(createMockSendEvent(), contextOverrides(), [], mode);
		expect(tools.dependencies_list?.execute).toBeTypeOf('function');
		expect(lastCodeModeTools().dependencies_list?.execute).toBeTypeOf('function');
		expect(tools).not.toHaveProperty('dependencies_update');
		expect(lastCodeModeTools()).not.toHaveProperty('dependencies_update');
	});

	it('honors dependency tool exclusions on both surfaces', async () => {
		const tools = await createServerTools(
			createMockSendEvent(),
			contextOverrides(),
			[],
			'code',
			undefined,
			undefined,
			undefined,
			undefined,
			new Set(['dependencies_update']),
		);
		expect(tools).not.toHaveProperty('dependencies_update');
		expect(lastCodeModeTools()).not.toHaveProperty('dependencies_update');
	});

	it('waits for MCP restoration and adds configured connectors to Code Mode', async () => {
		const { agent, waitForConnections } = createAgentWithMcpConnection();
		await createServerTools(createMockSendEvent(), contextOverrides({ agentReference: agent }), [], 'code');

		const options = mockCreateExecuteRuntime.mock.calls.at(-1)?.[0];
		expect(waitForConnections).toHaveBeenCalledWith();
		expect(options?.connectors).toHaveLength(1);
		expect(options?.connectors[0]?.name()).toBe('cloudflare_docs');
	});

	it('exposes browser_execute inside Code Mode tools.* in code mode with origin context', async () => {
		await createServerTools(createMockSendEvent(), contextOverrides(), [], 'code');

		const codeModeTools = lastCodeModeTools();
		expect(codeModeTools).toHaveProperty('browser_execute');
		const browserExecuteTool = codeModeTools.browser_execute;
		if (!browserExecuteTool || typeof browserExecuteTool.execute !== 'function') {
			throw new Error('browser_execute tool was not created');
		}
		await browserExecuteTool.execute({ code: 'async () => cdp.send("Page.navigate", { url: "/docs" })' });
		expect(mockBrowserExecute).toHaveBeenCalledWith(
			expect.objectContaining({ code: expect.stringContaining("project's preview origin") }),
			undefined,
		);
	});

	it('exposes quick action tools and omits browser_execute outside code mode', async () => {
		const tools = await createServerTools(createMockSendEvent(), contextOverrides(), [], 'plan');
		for (const name of ['read', 'ls', 'find', 'grep']) expect(tools).toHaveProperty(name);
		for (const name of ['write', 'edit', 'delete', 'exec']) expect(tools).not.toHaveProperty(name);

		const codeModeTools = lastCodeModeTools();
		expect(codeModeTools).not.toHaveProperty('browser_execute');
		expect(codeModeTools).toHaveProperty('browser_markdown');
		expect(codeModeTools).toHaveProperty('browser_extract');
		expect(codeModeTools).toHaveProperty('browser_links');
		expect(codeModeTools).toHaveProperty('browser_scrape');
	});

	it('restricts quick action tool URLs to the project preview origin', async () => {
		await createServerTools(createMockSendEvent(), contextOverrides(), [], 'code');

		const markdownTool = lastCodeModeTools().browser_markdown;
		if (!markdownTool || typeof markdownTool.execute !== 'function') {
			throw new Error('browser_markdown tool was not created');
		}

		await expect(markdownTool.execute({ url: 'https://evil.example.net/' })).rejects.toThrow(/preview origin/);
		expect(mockBrowserMarkdown).not.toHaveBeenCalled();
	});
});
