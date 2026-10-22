import { stripIndent } from 'common-tags';
import { z } from 'zod';

import { coordinatorNamespace } from '@worker/lib/durable-object-namespaces';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext, ToolResult } from '../types';

export const definition: ToolDefinition = {
	name: 'asset_settings_update',
	description: stripIndent`
    Update Cloudflare Workers asset routing settings for the project.
    These settings control how the deployed Worker handles static assets, 404 pages, HTML routing, and worker-first routing.
    They also affect the preview behavior in the IDE.

    Available settings:
    - not_found_handling: "none" | "single-page-application" | "404-page" (default: "none")
      Controls what happens when a request doesn't match a static asset.
      Use "single-page-application" for SPAs (serves index.html for unmatched routes).
      Use "404-page" for static sites (serves nearest 404.html).

    - html_handling: "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash" | "none" (default: "auto-trailing-slash")
      Controls trailing slash redirect behavior for HTML pages.

    - run_worker_first: "true" | "false" | comma-separated route patterns (default: "false")
      Controls whether the Worker runs before serving static assets.
      Use "true" to always run the Worker first.
      Use route patterns like "/api/*,!/api/docs/*" for selective routing.
  `,
	input_schema: {
		type: 'object',
		properties: {
			not_found_handling: {
				type: 'string',
				description: 'How to handle requests that don\'t match a static asset: "none", "single-page-application", or "404-page"',
			},
			html_handling: {
				type: 'string',
				description: 'Trailing slash behavior for HTML: "auto-trailing-slash", "force-trailing-slash", "drop-trailing-slash", or "none"',
			},
			run_worker_first: {
				type: 'string',
				description: 'Whether Worker runs before assets: "true", "false", or comma-separated route patterns like "/api/*,!/api/docs/*"',
			},
		},
	},
};

export async function execute(
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
): Promise<ToolResult> {
	sendEvent('status', { message: `Updating asset settings...` });
	using result = await context.fsStub.updateManagedConfiguration('asset_settings_update', input, context.sessionId);
	if (result.title !== 'no changes') {
		await coordinatorNamespace
			.getByName(`project:${context.projectId}`)
			.triggerUpdate({ type: 'full-reload', path: '/wrangler.jsonc', timestamp: Date.now(), targets: [] });
	}
	return { title: result.title, metadata: z.record(z.string(), z.unknown()).parse(JSON.parse(result.metadataJson)), output: result.output };
}
