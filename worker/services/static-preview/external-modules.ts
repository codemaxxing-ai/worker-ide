import { isAllowedPreviewExternalModuleUrl } from '@shared/preview-path';

import { rewriteExternalModuleImports } from '../transform-service';
import { cleanBuildErrorMessage } from './preview-errors';

interface ExternalModule {
	bodyText: string;
	contentType: string;
	finalUrl: string;
}

async function fetchExternalModule(externalUrl: string): Promise<ExternalModule> {
	const upstreamResponse = await fetch(externalUrl, { redirect: 'follow' });
	if (!upstreamResponse.ok) {
		throw new Error(`Failed to load external module ${externalUrl} (${upstreamResponse.status} ${upstreamResponse.statusText})`);
	}

	const finalUrl = new URL(upstreamResponse.url);
	if (!isAllowedPreviewExternalModuleUrl(finalUrl)) {
		throw new Error(`External module redirect target is not allowed: ${finalUrl.href}`);
	}

	const contentTypeHeader = upstreamResponse.headers.get('content-type') || 'application/javascript';
	const contentType = contentTypeHeader.split(';')[0]?.trim() || 'application/javascript';
	const bodyText = await upstreamResponse.text();
	return { bodyText, contentType, finalUrl: upstreamResponse.url };
}

async function serveExternalModule(externalUrl: string, requestTimestamp: string | undefined): Promise<Response> {
	try {
		const requestUrl = new URL(externalUrl);
		if (!isAllowedPreviewExternalModuleUrl(requestUrl)) {
			throw new Error(`Unsupported external module URL: ${requestUrl.href}`);
		}

		const externalModule = await fetchExternalModule(externalUrl);
		if (
			externalModule.contentType.includes('javascript') ||
			externalModule.contentType.includes('ecmascript') ||
			externalModule.contentType === 'text/plain'
		) {
			return new Response(rewriteExternalModuleImports(externalModule.bodyText, externalModule.finalUrl, requestTimestamp), {
				headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=1800' },
			});
		}

		return new Response(externalModule.bodyText, {
			headers: { 'Content-Type': externalModule.contentType, 'Cache-Control': 'public, max-age=1800' },
		});
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		const errorModule = `throw new Error(${JSON.stringify(cleanBuildErrorMessage(errorMessage))});`;
		return new Response(errorModule, {
			headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' },
		});
	}
}

export { serveExternalModule };
