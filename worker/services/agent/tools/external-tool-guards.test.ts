import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockContext, createMockSendEvent } from './test-helpers';

import type { BrowserBinding } from '../types';
import type { Agent } from 'agents';

const mockCreateExecuteRuntime = vi.fn();
const mockBrowserExecute = vi.fn(async ({ code }: { code: string }) => code);
const mockBrowserMarkdown = vi.fn(async (_input: { url?: string; html?: string }) => 'markdown');

vi.mock('cloudflare:workers', () => ({
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
		// Domain tools live inside Code Mode's tools.*, never at the top level.
		expect(tools).not.toHaveProperty('web_fetch');
		expect(tools).not.toHaveProperty('lint_fix');
		expect(mockCreateExecuteRuntime).toHaveBeenCalledWith(
			// eslint-disable-next-line unicorn/no-null -- codemode uses null to disable sandbox outbound network access
			expect.objectContaining({ globalOutbound: null, ctx: expect.anything(), state: expect.anything() }),
		);
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
