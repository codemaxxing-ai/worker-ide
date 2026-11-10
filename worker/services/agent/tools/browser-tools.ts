import { Browser, browserRun, DurableBrowserSessionStore } from 'agents/browser';
import { browserTool } from 'agents/browser/ai-sdk';
import { env } from 'cloudflare:workers';
import { z } from 'zod';

import { buildAllowedPreviewOrigins } from './network-policy';
import { DEV_PREVIEW_SECRET } from '../../../lib/preview-secret';

import type { ToolExecutorContext } from '../types';
import type { BrowserSource } from 'agents/browser';
import type { ToolSet } from 'ai';

export function assertPreviewUrl(url: string, allowedOrigins: readonly string[]): string {
	if (url === 'about:blank') return url;
	const resolved = new URL(url, allowedOrigins[0]);
	if (!['https:', 'http:'].includes(resolved.protocol) || !allowedOrigins.includes(resolved.origin))
		throw new Error('Browser tools may only access this project’s preview.');
	return resolved.toString();
}

function previewBrowserSource(browser: Browser, allowedOrigins: string[]): BrowserSource {
	return {
		name: browser.name,
		connect: async (options) => {
			const connection = await browser.connect(options);
			const send = connection.cdp.send.bind(connection.cdp);
			const attach = connection.cdp.attachToTarget.bind(connection.cdp);
			connection.cdp.send = async (method, parameters, sendOptions) => {
				if (method === 'Page.navigate' || method === 'Target.createTarget') {
					const navigation = z.object({ url: z.string() }).passthrough().parse(parameters);
					return send(method, { ...navigation, url: assertPreviewUrl(navigation.url, allowedOrigins) }, sendOptions);
				}
				return send(method, parameters, sendOptions);
			};
			connection.cdp.attachToTarget = async (targetId, attachOptions) => {
				const target = z.object({ targetInfo: z.object({ url: z.string() }) }).parse(await send('Target.getTargetInfo', { targetId }));
				assertPreviewUrl(target.targetInfo.url, allowedOrigins);
				return attach(targetId, attachOptions);
			};
			return connection;
		},
	};
}

export async function createPreviewBrowserTools(context: ToolExecutorContext, mode: 'code' | 'plan' | 'ask'): Promise<ToolSet> {
	if (!context.ctx || !context.loader || !context.browser || !context.requestOriginContext) return {};
	const secret = import.meta.env.DEV ? env.PREVIEW_SECRET || DEV_PREVIEW_SECRET : env.PREVIEW_SECRET;
	const origins = await buildAllowedPreviewOrigins(context.projectId, context.requestOriginContext, secret);
	if (origins.length === 0) return {};
	const browser = new Browser({
		name: 'preview',
		store: new DurableBrowserSessionStore(context.ctx.storage),
		provider: browserRun(context.browser, {
			guardrails: { allowedDomains: [...new Set(origins.map((origin) => new URL(origin).hostname))] },
		}),
	});
	const interactive = browserTool({
		browser: previewBrowserSource(browser, origins),
		loader: context.loader,
		scope: context.sessionId ?? context.projectId,
		timeoutMs: 60_000,
	});
	const tools: ToolSet = {
		browser_read: {
			...interactive,
			description: 'Read the rendered project preview, or capture a screenshot. Does not click controls or modify page content.',
			inputSchema: z.object({ url: z.string().optional(), screenshot: z.boolean().optional() }),
			execute: async ({ url, screenshot }, options) => {
				const destination = assertPreviewUrl(url ?? origins[0] ?? '', origins);
				const code = `async (browser) => { await browser.cdp({method:'Page.navigate',params:{url:${JSON.stringify(destination)}},sessionId:'active'}); ${
					screenshot
						? "const result = await browser.cdp({method:'Page.captureScreenshot',sessionId:'active'}); return {type:'browser_screenshot',mediaType:'image/png',data:result.data};"
						: "return await browser.cdp({method:'Runtime.evaluate',params:{expression:'document.body.innerText',returnByValue:true},sessionId:'active'});"
				} }`;
				return interactive.execute({ code }, options);
			},
		},
	};
	if (mode === 'code') tools.browser = interactive;
	return tools;
}
