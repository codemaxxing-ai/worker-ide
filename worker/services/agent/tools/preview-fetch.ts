import { env } from 'cloudflare:workers';

import { ToolExecutionError } from '@shared/tool-errors';

import { convertHtmlToMarkdown } from './html-to-markdown';
import { buildAllowedPreviewOrigins } from './network-policy';
import { getDomainConfiguration } from '../../../lib/domain-configuration';
import { DEV_PREVIEW_SECRET } from '../../../lib/preview-secret';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext, ToolResult } from '../types';

const DESCRIPTION = `Send an HTTP request to the project's live preview and return the response. Use this to debug pages, test API endpoints, verify server responses, and inspect rendered output.

Usage:
- The \`path\` parameter is a relative URL path (e.g. "/", "/about", "/api/users").
- The \`method\` parameter is the HTTP method (GET, POST, PUT, PATCH, DELETE). Defaults to GET.
- The \`headers\` parameter is a JSON-encoded object of request headers (e.g. '{"Content-Type": "application/json"}').
- The \`body\` parameter is the request body string (for POST, PUT, PATCH requests).
- The \`format\` parameter controls the response format: "raw" (default) returns the response body as-is, "markdown" converts HTML responses to markdown.
- Use this tool instead of web_fetch when you need to inspect your own project's preview output.
- If the preview has build errors or the path doesn't exist, the error details are returned in the response.`;

export const definition: ToolDefinition = {
	name: 'preview_fetch',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: 'Relative URL path to request (e.g. "/", "/about", "/api/users")',
			},
			method: {
				type: 'string',
				description: 'HTTP method to use. Defaults to "GET".',
				enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
			},
			headers: {
				type: 'string',
				description: 'JSON-encoded object of request headers (e.g. \'{"Content-Type": "application/json"}\')',
			},
			body: {
				type: 'string',
				description: 'Request body string (for POST, PUT, PATCH requests)',
			},
			format: {
				type: 'string',
				description: 'Response format: "raw" returns the body as-is (default), "markdown" converts HTML to markdown.',
				enum: ['raw', 'markdown'],
			},
		},
		required: ['path'],
	},
};
const MAX_RESPONSE_LENGTH = 20_000;
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);
const INTERESTING_HEADERS = new Set([
	'content-type',
	'content-length',
	'location',
	'set-cookie',
	'cache-control',
	'x-powered-by',
	'www-authenticate',
	'access-control-allow-origin',
]);
function parseHeaders(headersRaw: string): Headers {
	const parsed: unknown = JSON.parse(headersRaw);
	if (typeof parsed !== 'object' || !parsed || Array.isArray(parsed)) {
		throw new ToolExecutionError('MISSING_INPUT', 'Invalid headers: must be a JSON object (not array or primitive).');
	}
	const headers = new Headers();
	for (const [key, value] of Object.entries(parsed)) {
		if (typeof value === 'string') {
			headers.set(key, value);
		}
	}
	return headers;
}
function formatResponseHeaders(headers: Headers): string {
	const lines: string[] = [];
	for (const [key, value] of headers.entries()) {
		if (INTERESTING_HEADERS.has(key.toLowerCase())) {
			lines.push(`  ${key}: ${value}`);
		}
	}
	return lines.length > 0 ? lines.join('\n') : '  (none of interest)';
}
export async function execute(
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
): Promise<ToolResult> {
	const path = input.path;
	const method = (input.method ?? 'GET').toUpperCase();
	const headersRaw = input.headers;
	const body = input.body;
	const format = input.format ?? 'raw';

	if (!path) {
		throw new ToolExecutionError('MISSING_INPUT', 'The "path" parameter is required.');
	}

	// Validate path starts with /
	const normalizedPath = path.startsWith('/') ? path : `/${path}`;

	// Validate method
	const validMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
	if (!validMethods.has(method)) {
		throw new ToolExecutionError('MISSING_INPUT', `Invalid HTTP method: ${method}. Use GET, POST, PUT, PATCH, or DELETE.`);
	}

	// Parse headers if provided
	let requestHeaders: Headers;
	if (headersRaw) {
		try {
			requestHeaders = parseHeaders(headersRaw);
		} catch (error) {
			if (error instanceof ToolExecutionError) {
				throw error;
			}
			throw new ToolExecutionError('MISSING_INPUT', `Invalid headers JSON: ${String(error)}`);
		}
	} else {
		requestHeaders = new Headers();
	}

	// Warn if body is provided for GET/DELETE
	if (body && !BODY_METHODS.has(method)) {
		throw new ToolExecutionError('MISSING_INPUT', `Request body is not supported for ${method} requests. Use POST, PUT, or PATCH.`);
	}

	sendEvent('status', { message: `${method} ${normalizedPath}...` });

	try {
		// Lazy-import PreviewService to avoid pulling in chobitsu (which uses eval())
		// at module load time. This keeps the tool registry importable in test environments
		// where eval() is blocked (workerd).
		const { PreviewService } = await import('../../preview-service');
		const previewService = new PreviewService(context.projectRoot, context.projectId);
		const assetSettings = await previewService.loadAssetSettings();

		const origins = context.requestOriginContext ?? getDomainConfiguration(env);
		const secret = import.meta.env.DEV ? env.PREVIEW_SECRET || DEV_PREVIEW_SECRET : env.PREVIEW_SECRET;
		const [previewOrigin] = await buildAllowedPreviewOrigins(context.projectId, origins, secret);
		const syntheticUrl = new URL(normalizedPath, previewOrigin);
		if (
			syntheticUrl.origin !== previewOrigin ||
			syntheticUrl.username ||
			syntheticUrl.password ||
			syntheticUrl.pathname.startsWith('/__preview-auth')
		) {
			throw new ToolExecutionError('NOT_ALLOWED', 'Only this project’s application paths are allowed.');
		}

		const requestInit: RequestInit = {
			method,
			headers: requestHeaders,
		};
		if (body && BODY_METHODS.has(method)) {
			requestInit.body = body;
		}
		const request = new Request(syntheticUrl.toString(), requestInit);

		const response = await previewService.routePreviewRequest(request, origins.appOrigin, assetSettings);

		// Read response body
		const contentType = response.headers.get('content-type') ?? '';
		let responseBody = await response.text();

		// Convert to markdown if requested and response is HTML
		if (format === 'markdown' && contentType.includes('text/html')) {
			sendEvent('status', { message: 'Converting to markdown...' });
			try {
				const markdown = await convertHtmlToMarkdown(responseBody);
				if (markdown) {
					responseBody = markdown;
				}
			} catch {
				// Fall back to raw HTML if conversion fails
				responseBody = `[Markdown conversion failed, returning raw HTML]\n\n${responseBody}`;
			}
		}

		// Truncate if too large
		const wasTruncated = responseBody.length > MAX_RESPONSE_LENGTH;
		if (wasTruncated) {
			responseBody = responseBody.slice(0, MAX_RESPONSE_LENGTH) + '\n... (truncated)';
		}

		const headersDisplay = formatResponseHeaders(response.headers);

		const output = [
			`${method} ${normalizedPath} — ${response.status} ${response.statusText}`,
			'',
			'Response headers:',
			headersDisplay,
			'',
			'Body:',
			responseBody,
		].join('\n');

		return {
			title: `${method} ${normalizedPath} → ${response.status}`,
			metadata: {
				path: normalizedPath,
				method,
				status: response.status,
				statusText: response.statusText,
				contentType,
				bodyLength: responseBody.length,
				truncated: wasTruncated,
			},
			output,
		};
	} catch (error) {
		if (error instanceof ToolExecutionError) {
			throw error;
		}

		// Preview errors (bundle failures, runtime errors) are valuable debugging info —
		// return them as results rather than throwing so the agent can act on them.
		const errorMessage = error instanceof Error ? error.message : String(error);
		return {
			title: `${method} ${normalizedPath} → Error`,
			metadata: {
				path: normalizedPath,
				method,
				error: errorMessage,
			},
			output: `${method} ${normalizedPath} — Request failed\n\nError: ${errorMessage}`,
		};
	}
}
