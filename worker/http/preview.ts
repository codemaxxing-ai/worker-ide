import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import { PROJECT_ROOT } from './project-context';
import { hasValidWebSocketOrigin } from './security';
import * as authSchema from '../db/auth-schema';
import { trackPreviewRequest } from '../lib/analytics';
import { getDomainConfiguration } from '../lib/domain-configuration';
import { coordinatorNamespace, filesystemNamespace } from '../lib/durable-object-namespaces';
import { errorPage, previewAccessPage } from '../lib/error-page';
import {
	buildPreviewAccessBootstrapUrl,
	createPreviewAccessCookieToken,
	isNavigationRequest,
	PREVIEW_ACCESS_REDEEM_PATH,
	PREVIEW_ACCESS_CHECK_PATH,
	PREVIEW_ACCESS_PREFIX,
	readPreviewAccessCookie,
	readPreviewAccessGrant,
	serializePreviewAccessCookie,
} from '../lib/preview-access';
import { PREVIEW_BOOTSTRAP_INPUTS } from '../lib/preview-bootstrap';
import { DEV_PREVIEW_SECRET } from '../lib/preview-secret';
import { runWithProjectStub } from '../lib/project-fs';
import { toDurableObjectId } from '../lib/project-id';

/**
 * Handle all requests on flat signed project hosts under CONTENT_ORIGIN.
 * The request path maps directly to the user's project filesystem.
 */
export async function handlePreviewRequest(request: Request, projectId: string, previewToken: string): Promise<Response> {
	const previewStart = Date.now();
	const url = new URL(request.url);

	function trackAndReturn(response: Response, visibility = ''): Response {
		trackPreviewRequest({
			projectId,
			pathname: url.pathname,
			contentType: response.headers.get('Content-Type') ?? '',
			visibility,
			statusCode: response.status,
			durationMs: Date.now() - previewStart,
			responseSize: Number(response.headers.get('Content-Length') ?? 0),
			request,
		});
		return response;
	}

	const { appOrigin } = getDomainConfiguration(env);

	const homeUrl = `${appOrigin}/`;

	let fsId: DurableObjectId;
	try {
		fsId = toDurableObjectId(filesystemNamespace, projectId);
	} catch {
		return trackAndReturn(
			errorPage({
				heading: 'Invalid project',
				message: 'The project ID in this URL is not valid.',
				homeUrl,
				status: 400,
			}),
		);
	}

	const fsStub = filesystemNamespace.get(fsId);

	// Prime the preview (existence + wrangler + runtime probe) in a SINGLE cross-DO
	// round trip, concurrently with the D1 gating query. Both are always needed
	// before serving, and the bootstrap replaces the previous sequential
	// `projectExists()` + per-asset tree reads.
	const previewDatabase = drizzle(env.DB, { schema: authSchema });
	const [previewBootstrapResult, previewProjectRow] = await Promise.all([
		fsStub.collectPreviewBootstrap(PREVIEW_BOOTSTRAP_INPUTS),
		previewDatabase
			.select({
				deletedAt: authSchema.project.deletedAt,
				organizationDeletedAt: authSchema.organization.deletedAt,
				projectBannedAt: authSchema.project.bannedAt,
				orgBannedAt: authSchema.organization.bannedAt,
				previewVisibility: authSchema.project.previewVisibility,
				organizationId: authSchema.project.organizationId,
			})
			.from(authSchema.project)
			.leftJoin(authSchema.organization, eq(authSchema.project.organizationId, authSchema.organization.id))
			.where(eq(authSchema.project.id, projectId))
			.limit(1),
	]);
	using previewBootstrap = previewBootstrapResult;

	if (!previewBootstrap.exists) {
		return trackAndReturn(
			errorPage({
				heading: 'Project not found',
				message: "The project you're looking for doesn't exist or has expired.",
				homeUrl,
				status: 404,
			}),
		);
	}

	if (previewProjectRow.length === 0) {
		return trackAndReturn(
			errorPage({
				heading: 'Project not found',
				message: "The project you're looking for doesn't exist.",
				homeUrl,
				status: 404,
			}),
		);
	}

	if (previewProjectRow[0].deletedAt || previewProjectRow[0].organizationDeletedAt) {
		return trackAndReturn(
			errorPage({
				heading: 'Project deleted',
				message: 'This project has been deleted.',
				homeUrl,
				status: 404,
			}),
		);
	}

	if (previewProjectRow[0].projectBannedAt || previewProjectRow[0].orgBannedAt) {
		return trackAndReturn(
			errorPage({
				heading: 'Access restricted',
				message: 'Please contact us for assistance.',
				homeUrl,
				status: 403,
			}),
		);
	}

	const previewVisibility = previewProjectRow[0].previewVisibility ?? 'public';
	const previewSecret = import.meta.env.DEV ? env.PREVIEW_SECRET || DEV_PREVIEW_SECRET : env.PREVIEW_SECRET;

	if (url.pathname.startsWith(PREVIEW_ACCESS_PREFIX) && request.method !== 'GET' && request.method !== 'HEAD')
		return new Response('Method not allowed', { status: 405 });

	if (url.pathname === PREVIEW_ACCESS_REDEEM_PATH) {
		const grantToken = url.searchParams.get('grant');
		const grantPayload = grantToken ? await readPreviewAccessGrant(grantToken, previewSecret) : undefined;
		if (
			!grantPayload ||
			grantPayload.projectId !== projectId ||
			grantPayload.previewToken !== previewToken ||
			grantPayload.previewOrigin !== url.origin ||
			grantPayload.organizationId !== previewProjectRow[0].organizationId
		) {
			if (request.headers.get('Sec-Fetch-Dest') === 'iframe')
				return trackAndReturn(previewAccessPage(appOrigin, 'required'), previewVisibility);
			return trackAndReturn(
				errorPage({
					heading: 'Preview access expired',
					message: 'This preview access link is no longer valid. Open the editor to get a fresh preview link.',
					homeUrl,
					status: 403,
				}),
				previewVisibility,
			);
		}

		const cookieToken = await createPreviewAccessCookieToken(
			{
				projectId,
				previewToken,
				previewOrigin: url.origin,
				organizationId: grantPayload.organizationId,
				userId: grantPayload.userId,
			},
			previewSecret,
		);
		const headers = new Headers();
		const checkUrl = new URL(PREVIEW_ACCESS_CHECK_PATH, url.origin);
		checkUrl.searchParams.set('path', grantPayload.redirectPath);
		headers.set('Location', checkUrl.toString());
		headers.set('Set-Cookie', serializePreviewAccessCookie(cookieToken));
		headers.set('Cache-Control', 'no-store');
		return trackAndReturn(new Response(undefined, { status: 302, headers }), previewVisibility);
	}

	let accessExpiresAt: number | undefined;
	// Enforce preview visibility with a preview-only host cookie. The preview host
	// never receives app session cookies; it only sees its own scoped access grant.
	if (previewProjectRow[0].previewVisibility === 'private') {
		const previewAccess = await readPreviewAccessCookie(
			request.headers,
			previewSecret,
			projectId,
			previewToken,
			url,
			previewProjectRow[0].organizationId,
		);
		if (!previewAccess) {
			if (url.pathname === PREVIEW_ACCESS_CHECK_PATH) return trackAndReturn(previewAccessPage(appOrigin, 'blocked'), previewVisibility);
			if (isNavigationRequest(request)) {
				if (request.headers.get('Sec-Fetch-Dest') === 'iframe')
					return trackAndReturn(previewAccessPage(appOrigin, 'required'), previewVisibility);
				return trackAndReturn(
					Response.redirect(buildPreviewAccessBootstrapUrl(appOrigin, projectId, url.toString()), 302),
					previewVisibility,
				);
			}
			return trackAndReturn(new Response('Forbidden', { status: 403, headers: { 'Cache-Control': 'no-store' } }), previewVisibility);
		}
		accessExpiresAt = previewAccess.expiresAt;
	}
	if (url.pathname === PREVIEW_ACCESS_CHECK_PATH) {
		let target: URL;
		try {
			target = new URL(url.searchParams.get('path') || '/', url.origin);
		} catch {
			return new Response('Invalid preview path', { status: 400 });
		}
		if (target.origin !== url.origin || target.username || target.password || target.pathname.startsWith(PREVIEW_ACCESS_PREFIX))
			return new Response('Invalid preview path', { status: 400 });
		return trackAndReturn(
			new Response(undefined, { status: 302, headers: { Location: target.toString(), 'Cache-Control': 'no-store' } }),
			previewVisibility,
		);
	}
	if (url.pathname.startsWith(PREVIEW_ACCESS_PREFIX)) return new Response('Not found', { status: 404 });

	const response = await runWithProjectStub(fsStub, async () => {
		if (url.pathname === '/__ws' || url.pathname.startsWith('/__ws')) {
			if (!hasValidWebSocketOrigin(request, url.origin)) {
				return new Response('Forbidden', { status: 403 });
			}
			const coordinatorStub = coordinatorNamespace.getByName(`project:${projectId}`);
			const wsUrl = new URL(request.url);
			wsUrl.pathname = '/ws';
			const wsRequest = new Request(wsUrl, request);
			wsRequest.headers.set('x-project-id', projectId);
			wsRequest.headers.set('x-worker-ide-client-kind', 'preview');
			return coordinatorStub.fetch(wsRequest);
		}

		// Preview services carry no cross-request state. Loading it lazily keeps
		// browser-only preview code out of the Worker startup module graph.
		const { PreviewService } = await import('../services/preview-service');
		const previewService = new PreviewService(PROJECT_ROOT, projectId);
		const assetSettings = await previewService.loadAssetSettings();

		return previewService.routePreviewRequest(request, appOrigin, assetSettings, previewBootstrap.snapshotHash, previewBootstrap);
	});

	if (accessExpiresAt !== undefined && response.headers.get('Content-Type')?.includes('text/html')) {
		const refreshDelay = Math.max(0, accessExpiresAt - Date.now() - 1000);
		const bootstrapUrl = buildPreviewAccessBootstrapUrl(appOrigin, projectId, url.toString());
		const script = `<script>setTimeout(function(){if(window.parent!==window){window.parent.postMessage({type:'__preview-access-required'},${JSON.stringify(appOrigin)});}else{window.location.replace(${JSON.stringify(bootstrapUrl)});}},${refreshDelay});</script>`;
		return trackAndReturn(
			new HTMLRewriter()
				.on('head', {
					element(element) {
						element.append(script, { html: true });
					},
				})
				.transform(response),
			previewVisibility,
		);
	}
	return trackAndReturn(response, previewVisibility);
}
