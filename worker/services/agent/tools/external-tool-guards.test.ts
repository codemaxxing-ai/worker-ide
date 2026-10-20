import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockContext, createMockSendEvent } from './test-helpers';

import type { BrowserBinding } from '../types';
import type { Agent } from 'agents';

const mockCreateExecuteRuntime = vi.fn();
const mockBrowserExecute = vi.fn(async ({ code }: { code: string }) => code);
const mockBrowserMarkdown = vi.fn(async (_input: { url?: string; html?: string }) => 'markdown');

vi.mock('cloudflare:workers', () => ({
	tracing: undefined,
	env: {
		PREVIEW_SECRET: 'test-preview-secret',
	},
}));

vi.mock('@cloudflare/think/tools/execute', () => ({
	createExecuteRuntime: (...arguments_: Parameters<typeof mockCreateExecuteRuntime>) => {
		mockCreateExecuteRuntime(...arguments_);
		return { runtime: {}, connectors: [], tool: { description: 'codemode', inputSchema: {}, execute: vi.fn() } };
	},
}));

vi.mock('@cloudflare/think/tools/browser', () => ({
	createBrowserTools: () => ({
		browser_markdown: { description: 'markdown', inputSchema: {}, execute: mockBrowserMarkdown },
		browser_extract: { description: 'extract', inputSchema: {}, execute: vi.fn(async () => 'extract') },
		browser_links: { description: 'links', inputSchema: {}, execute: vi.fn(async () => 'links') },
		browser_scrape: { description: 'scrape', inputSchema: {}, execute: vi.fn(async () => 'scrape') },
		browser_execute: { description: 'execute', inputSchema: {}, execute: mockBrowserExecute },
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
	return createMockContext({
		projectId: 'project123',
		ctx: createMockDurableObjectState(),
		loader: createLoader(),
		browser: createBrowserFetcher(),
		requestOriginContext: { appOrigin: 'https://example.com', contentOrigin: 'https://content.example.net' },
		...overrides,
	});
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
