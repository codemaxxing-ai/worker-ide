import { buildPreviewOrigin } from '@shared/domain';
import { currentBucket, generatePreviewTokenForBucket } from '@shared/preview-token';
import { ToolExecutionError } from '@shared/tool-errors';

import type { RequestOriginContext } from '../request-origin-context';

const BLOCKED_HOSTNAMES = new Set([
	'localhost',
	'0.0.0.0',
	'127.0.0.1',
	'::1',
	'[::1]',
	'host.docker.internal',
	'metadata',
	'metadata.google.internal',
	'169.254.169.254',
]);

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home', '.lan'];
const TEXT_CONTENT_TYPES = new Set([
	'application/json',
	'application/ld+json',
	'application/xhtml+xml',
	'application/xml',
	'image/svg+xml',
]);

function normalizeHostname(hostname: string): string {
	return hostname
		.trim()
		.toLowerCase()
		.replaceAll(/^\[|\]$/g, '');
}

function isIpv4Address(hostname: string): boolean {
	const parts = hostname.split('.');
	if (parts.length !== 4) {
		return false;
	}

	return parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function isPrivateIpv4(hostname: string): boolean {
	if (!isIpv4Address(hostname)) {
		return false;
	}

	const octets = hostname.split('.').map(Number);
	const [first, second] = octets;
	return (
		first === 0 ||
		first === 10 ||
		first === 127 ||
		(first === 169 && second === 254) ||
		(first === 172 && second >= 16 && second <= 31) ||
		(first === 192 && second === 168) ||
		(first === 100 && second >= 64 && second <= 127)
	);
}

function isPrivateIpv6(hostname: string): boolean {
	const normalized = normalizeHostname(hostname);
	return normalized === '::1' || normalized === '0:0:0:0:0:0:0:1' || /^(fc|fd)/.test(normalized) || /^fe[89ab]/.test(normalized);
}

function isBlockedHostname(hostname: string): boolean {
	const normalized = normalizeHostname(hostname);
	return (
		BLOCKED_HOSTNAMES.has(normalized) ||
		BLOCKED_SUFFIXES.some((suffix) => normalized.endsWith(suffix)) ||
		isPrivateIpv4(normalized) ||
		isPrivateIpv6(normalized)
	);
}

function isSameDeploymentHost(url: URL, requestOriginContext?: RequestOriginContext): boolean {
	if (!requestOriginContext) {
		return false;
	}

	const hostname = normalizeHostname(url.hostname);
	return [requestOriginContext.appOrigin, requestOriginContext.contentOrigin].some((origin) => {
		const baseHostname = new URL(origin).hostname;
		return hostname === baseHostname || hostname.endsWith(`.${baseHostname}`);
	});
}

function isTextContentType(contentType: string): boolean {
	const normalized = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
	return normalized === '' || normalized.startsWith('text/') || TEXT_CONTENT_TYPES.has(normalized);
}

async function readResponseBody(response: Response, maxBytes: number): Promise<{ body: string; truncated: boolean }> {
	if (!response.body) {
		return { body: '', truncated: false };
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	let truncated = false;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (!value) {
				continue;
			}

			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				const remainingBytes = Math.max(0, maxBytes - (totalBytes - value.byteLength));
				chunks.push(value.slice(0, remainingBytes));
				truncated = true;
				await reader.cancel();
				break;
			}

			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return {
		body: new TextDecoder().decode(merged),
		truncated,
	};
}

export function assertSafeExternalUrl(url: URL, requestOriginContext?: RequestOriginContext): void {
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new ToolExecutionError('MISSING_INPUT', 'Only http:// and https:// URLs are supported.');
	}

	if (url.username || url.password) {
		throw new ToolExecutionError('NOT_ALLOWED', 'Credentialed URLs are not allowed.');
	}

	if (isBlockedHostname(url.hostname)) {
		throw new ToolExecutionError('NOT_ALLOWED', `Blocked target host: ${url.hostname}`);
	}

	if (isSameDeploymentHost(url, requestOriginContext)) {
		throw new ToolExecutionError('NOT_ALLOWED', 'Use preview_fetch for project preview requests instead of web_fetch.');
	}
}

export async function fetchTextWithSafeRedirects(
	url: URL,
	requestOriginContext: RequestOriginContext | undefined,
	options: RequestInit & { maxRedirects?: number; maxBytes?: number },
): Promise<{ finalUrl: URL; response: Response; body: string; truncated: boolean }> {
	const maxRedirects = options.maxRedirects ?? 5;
	const maxBytes = options.maxBytes ?? 250_000;
	let currentUrl = url;

	for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
		assertSafeExternalUrl(currentUrl, requestOriginContext);

		const response = await fetch(currentUrl, {
			...options,
			redirect: 'manual',
		});

		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get('location');
			if (!location) {
				throw new ToolExecutionError('MISSING_INPUT', `Redirect from ${currentUrl.toString()} did not include a location.`);
			}

			currentUrl = new URL(location, currentUrl);
			continue;
		}

		const contentType = response.headers.get('content-type') ?? '';
		if (!isTextContentType(contentType)) {
			throw new ToolExecutionError('NOT_ALLOWED', `Unsupported content type: ${contentType || 'unknown'}`);
		}

		const { body, truncated } = await readResponseBody(response, maxBytes);
		return { finalUrl: currentUrl, response, body, truncated };
	}

	throw new ToolExecutionError('MISSING_INPUT', `Too many redirects while fetching ${url.toString()}.`);
}

export async function buildAllowedPreviewOrigins(
	projectId: string,
	requestOriginContext: RequestOriginContext,
	secret: string,
): Promise<string[]> {
	const bucket = currentBucket();
	const tokens = await Promise.all([
		generatePreviewTokenForBucket(projectId, secret, bucket),
		generatePreviewTokenForBucket(projectId, secret, bucket - 1),
	]);

	return [...new Set(tokens)].map((token) => buildPreviewOrigin(projectId, token, requestOriginContext.contentOrigin));
}
