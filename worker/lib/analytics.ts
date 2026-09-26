import { env } from 'cloudflare:workers';

function safeWrite(binding: AnalyticsEngineDataset | undefined, dataPoint: AnalyticsEngineDataPoint): void {
	if (!binding?.writeDataPoint) return;
	binding.writeDataPoint(dataPoint);
}

function getRequestCfString(request: Request, key: 'colo' | 'country'): string {
	const cf = Reflect.get(request, 'cf');
	if (!cf || typeof cf !== 'object') return '';

	const value = Reflect.get(cf, key);
	return typeof value === 'string' ? value : '';
}

function getColo(request?: Request): string {
	if (!request) {
		return '';
	}

	return getRequestCfString(request, 'colo');
}

function getCountry(request?: Request): string {
	if (!request) {
		return '';
	}

	return getRequestCfString(request, 'country');
}

function getVersionTag(): string {
	return env.CF_VERSION_METADATA?.tag ?? '';
}

interface ApiRequestEvent {
	userId: string;
	route: string;
	method: string;
	projectId?: string;
	organizationId?: string;
	statusCode: number;
	durationMs: number;
	error?: string;
	plan?: string;
	request: Request;
}

/**
 * Track an API request (both root-level and project-scoped).
 *
 * Schema:
 * - index1: userId (sampling key)
 * - blob1: route pattern, blob2: projectId, blob3: orgId, blob4: method,
 *   blob5: colo, blob6: country, blob7: error, blob8: version, blob9: plan
 * - double1: durationMs, double2: statusCode
 */
export function trackApiRequest(event: ApiRequestEvent): void {
	safeWrite(env.ANALYTICS_API, {
		indexes: [event.userId],
		blobs: [
			`${event.method} ${event.route}`,
			event.projectId ?? '',
			event.organizationId ?? '',
			event.method,
			getColo(event.request),
			getCountry(event.request),
			event.error ?? '',
			getVersionTag(),
			event.plan ?? '',
		],
		doubles: [event.durationMs, event.statusCode],
	});
}

type ProjectEventType = 'create' | 'clone' | 'delete' | 'restore' | 'deploy' | 'download';

interface ProjectEvent {
	organizationId: string;
	eventType: ProjectEventType;
	projectId: string;
	userId: string;
	detail?: string;
	plan?: string;
	error?: string;
	durationMs: number;
	success: boolean;
	request?: Request;
}

/**
 * Track a project lifecycle event.
 *
 * Schema:
 * - index1: organizationId (sampling key)
 * - blob1: eventType, blob2: projectId, blob3: userId, blob4: detail,
 *   blob5: plan, blob6: error, blob7: colo
 * - double1: durationMs, double2: success (1/0)
 */
export function trackProjectEvent(event: ProjectEvent): void {
	safeWrite(env.ANALYTICS_PROJECTS, {
		indexes: [event.organizationId],
		blobs: [
			event.eventType,
			event.projectId,
			event.userId,
			event.detail ?? '',
			event.plan ?? '',
			event.error ?? '',
			getColo(event.request),
		],
		doubles: [event.durationMs, event.success ? 1 : 0],
	});
}

interface PreviewRequestEvent {
	projectId: string;
	pathname: string;
	contentType?: string;
	visibility?: string;
	error?: string;
	statusCode: number;
	durationMs: number;
	responseSize: number;
	request: Request;
}

/**
 * Track a preview subdomain request.
 *
 * Schema:
 * - index1: projectId (sampling key)
 * - blob1: pathname, blob2: colo, blob3: country, blob4: error,
 *   blob5: contentType, blob6: visibility
 * - double1: durationMs, double2: statusCode, double3: responseSize
 */
export function trackPreviewRequest(event: PreviewRequestEvent): void {
	safeWrite(env.ANALYTICS_PREVIEW, {
		indexes: [event.projectId],
		blobs: [
			event.pathname,
			getColo(event.request),
			getCountry(event.request),
			event.error ?? '',
			event.contentType ?? '',
			event.visibility ?? '',
		],
		doubles: [event.durationMs, event.statusCode, event.responseSize],
	});
}

type AuthEventType = 'signup' | 'login' | 'org_create' | 'org_invite' | 'org_join' | 'project_transfer' | 'account_delete';

interface AuthEvent {
	userId: string;
	eventType: AuthEventType;
	organizationId?: string;
	provider?: string;
	plan?: string;
	request?: Request;
}

/**
 * Track an authentication or user lifecycle event.
 *
 * Schema:
 * - index1: userId (sampling key)
 * - blob1: eventType, blob2: orgId, blob3: provider, blob4: plan,
 *   blob5: colo, blob6: country
 * - double1: 1 (count)
 */
export function trackAuthEvent(event: AuthEvent): void {
	safeWrite(env.ANALYTICS_AUTH, {
		indexes: [event.userId],
		blobs: [
			event.eventType,
			event.organizationId ?? '',
			event.provider ?? '',
			event.plan ?? '',
			event.request ? getColo(event.request) : '',
			event.request ? getCountry(event.request) : '',
		],
		doubles: [1],
	});
}

type WebSocketEventType = 'connect' | 'disconnect';
type WebSocketConnectionType = 'coordinator' | 'agent';

interface WebSocketEvent {
	projectId: string;
	eventType: WebSocketEventType;
	connectionType: WebSocketConnectionType;
	userId?: string;
	concurrentConnections?: number;
	durationMs?: number;
}

/**
 * Track a WebSocket connection or disconnection event.
 *
 * Schema:
 * - index1: projectId (sampling key)
 * - blob1: eventType, blob2: connectionType, blob3: userId
 * - double1: concurrentConnections, double2: durationMs
 */
export function trackWebSocketEvent(event: WebSocketEvent): void {
	safeWrite(env.ANALYTICS_WS, {
		indexes: [event.projectId],
		blobs: [event.eventType, event.connectionType, event.userId ?? ''],
		doubles: [event.concurrentConnections ?? 0, event.durationMs ?? 0],
	});
}

type SttEventType = 'session_start' | 'session_end';

interface SttEvent {
	userId: string;
	projectId: string;
	eventType: SttEventType;
	durationMs?: number;
	error?: string;
	request: Request;
}

/**
 * Track a speech-to-text session.
 *
 * Schema:
 * - index1: userId (sampling key)
 * - blob1: eventType, blob2: projectId, blob3: error, blob4: colo, blob5: country
 * - double1: durationMs
 */
export function trackSttEvent(event: SttEvent): void {
	safeWrite(env.ANALYTICS_STT, {
		indexes: [event.userId],
		blobs: [event.eventType, event.projectId, event.error ?? '', getColo(event.request), getCountry(event.request)],
		doubles: [event.durationMs ?? 0],
	});
}
