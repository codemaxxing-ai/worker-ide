import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import { buildAppOrigin, parseHost } from '@shared/domain';

import { PROJECT_ROOT } from './project-context';
import { hasValidWebSocketOrigin } from './security';
import * as authSchema from '../db/auth-schema';
import { trackPreviewRequest } from '../lib/analytics';
import { coordinatorNamespace, filesystemNamespace } from '../lib/durable-object-namespaces';
import { errorPage } from '../lib/error-page';
import {
	buildPreviewAccessBootstrapUrl,
	clearPreviewAccessCookie,
	createPreviewAccessCookieToken,
	isNavigationRequest,
	PREVIEW_ACCESS_REDEEM_PATH,
	readPreviewAccessCookie,
	readPreviewAccessGrant,
	serializePreviewAccessCookie,
} from '../lib/preview-access';
import { PREVIEW_BOOTSTRAP_INPUTS } from '../lib/preview-bootstrap';
import { DEV_PREVIEW_SECRET } from '../lib/preview-secret';
import { runWithProjectStub } from '../lib/project-fs';
import { toDurableObjectId } from '../lib/project-id';

/**
 * Detect cross-site hotlink requests using Sec-Fetch metadata headers.
 *
 * Blocks requests where `Sec-Fetch-Site` is `cross-site` and
 * `Sec-Fetch-Dest` is NOT a navigation destination. This prevents
 * external pages from hotlinking preview JS, CSS, images, etc. while
 * still allowing:
 *
 * - IDE `<iframe>` navigation (cross-site + dest=iframe → allowed)
 * - Top-level navigation / bookmark (cross-site + dest=document → allowed)
 * - Typed URL / bookmark (Sec-Fetch-Site=none → allowed)
 * - Same-origin requests within the preview (same-origin → allowed)
 * - Non-browser clients that don't send Sec-Fetch headers (allowed,
 *   since these headers are browser-only and cannot be spoofed by JS)
 */
export function isHotlinkRequest(request: Request): boolean {
	const fetchSite = request.headers.get('Sec-Fetch-Site');
	const fetchDestination = request.headers.get('Sec-Fetch-Dest');

	// Only act when the browser explicitly tells us the request is cross-site.
	// Absence of the header (non-browser clients, older browsers) is allowed.
	if (fetchSite !== 'cross-site') return false;

	// Cross-site navigations are legitimate. `document` is used for top-level
	// navigations, `iframe` for <iframe> navigations (the IDE embeds the
	// preview in an iframe). Everything else (script, style, image, empty,
	// etc.) is a subresource fetch and treated as hotlinking.
	return fetchDestination !== 'document' && fetchDestination !== 'iframe';
}

/**
 * Paths that belong to the IDE's dev infrastructure (Vite, PWA, etc.)
 * rather than user project files. When these are requested on a preview
 * subdomain (due to the browser's service worker, favicon probe, etc.)
 * we delegate to the asset pipeline instead of the preview filesystem.
 */
const DEV_INFRASTRUCTURE_PREFIXES = ['/@vite/', '/@vite-plugin-', '/@fs/', '/@id/', '/.well-known/', '/workbox-'];
const DEV_INFRASTRUCTURE_EXACT = new Set(['/@react-refresh', '/dev-sw.js', '/sw.js', '/sw.js.map']);

function isDevelopmentInfrastructurePath(pathname: string): boolean {
	if (DEV_INFRASTRUCTURE_EXACT.has(pathname)) return true;
	return DEV_INFRASTRUCTURE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Handle all requests on `<projectId>.preview.<baseDomain>`.
 * The request path maps directly to the user's project filesystem.
 */
export async function handlePreviewRequest(request: Request, projectId: string, previewToken: string): Promise<Response> {
	const previewStart = Date.now();
	const url = new URL(request.url);

	if (isDevelopmentInfrastructurePath(url.pathname)) {
		return env.ASSETS.fetch(request);
	}
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

	const appOrigin = buildAppOrigin(parseHost(url.host).baseDomain, url.protocol);

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

	if (previewProjectRow[0].deletedAt) {
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

	if (url.pathname === PREVIEW_ACCESS_REDEEM_PATH) {
		const grantToken = url.searchParams.get('grant');
		const grantPayload = grantToken ? await readPreviewAccessGrant(grantToken, previewSecret) : undefined;
		if (!grantPayload || grantPayload.projectId !== projectId || grantPayload.previewToken !== previewToken) {
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
				organizationId: grantPayload.organizationId,
				userId: grantPayload.userId,
			},
			previewSecret,
		);
		const headers = new Headers();
		headers.set('Location', new URL(grantPayload.redirectPath, url.origin).toString());
		for (const cookie of serializePreviewAccessCookie(cookieToken, url)) {
			headers.append('Set-Cookie', cookie);
		}
		return trackAndReturn(new Response(undefined, { status: 302, headers }), previewVisibility);
	}

	// Enforce preview visibility with a preview-only host cookie. The preview host
	// never receives app session cookies; it only sees its own scoped access grant.
	if (previewProjectRow[0].previewVisibility === 'private') {
		const previewAccess = await readPreviewAccessCookie(request.headers, previewSecret, projectId, previewToken, url);
		if (!previewAccess) {
			if (isNavigationRequest(request)) {
				return trackAndReturn(
					Response.redirect(buildPreviewAccessBootstrapUrl(appOrigin, projectId, url.toString()), 302),
					previewVisibility,
				);
			}

			return trackAndReturn(
				new Response('Forbidden', {
					status: 403,
					headers: (() => {
						const headers = new Headers({ 'Cache-Control': 'no-cache' });
						for (const cookie of clearPreviewAccessCookie(url)) {
							headers.append('Set-Cookie', cookie);
						}
						return headers;
					})(),
				}),
				previewVisibility,
			);
		}
	}

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

	return trackAndReturn(response, previewVisibility);
}
