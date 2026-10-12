import { serialize } from 'hono/utils/cookie';

import { constantTimeEqual } from '@shared/preview-token';

const PREVIEW_ACCESS_COOKIE_NAME = '__Host-worker-ide-preview-access';
const PREVIEW_ACCESS_COOKIE_MAX_AGE_SECONDS = 55 * 60;
const PREVIEW_ACCESS_GRANT_MAX_AGE_SECONDS = 60;
export const PREVIEW_ACCESS_PREFIX = '/__preview-auth';
export const PREVIEW_ACCESS_REDEEM_PATH = `${PREVIEW_ACCESS_PREFIX}/redeem`;
export const PREVIEW_ACCESS_CHECK_PATH = `${PREVIEW_ACCESS_PREFIX}/check`;

interface PreviewAccessEnvelope {
	payload: string;
	signature: string;
}

export interface PreviewAccessGrantPayload {
	projectId: string;
	previewToken: string;
	previewOrigin: string;
	organizationId: string;
	userId: string;
	redirectPath: string;
	expiresAt: number;
}

export interface PreviewAccessCookiePayload {
	projectId: string;
	previewToken: string;
	previewOrigin: string;
	organizationId: string;
	userId: string;
	expiresAt: number;
}

function encodeBase64Url(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCodePoint(byte);
	}
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll(/=+$/g, '');
}

function decodeBase64Url(value: string): string | undefined {
	try {
		const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
		const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
		const binary = atob(padded);
		const bytes = Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
		return new TextDecoder().decode(bytes);
	} catch {
		return undefined;
	}
}

async function hmacBase64Url(secret: string, value: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
	let binary = '';
	for (const byte of new Uint8Array(signature)) {
		binary += String.fromCodePoint(byte);
	}
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll(/=+$/g, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isPreviewAccessGrantPayload(value: unknown): value is PreviewAccessGrantPayload {
	return (
		isRecord(value) &&
		typeof value.projectId === 'string' &&
		typeof value.previewToken === 'string' &&
		typeof value.previewOrigin === 'string' &&
		typeof value.organizationId === 'string' &&
		typeof value.userId === 'string' &&
		typeof value.redirectPath === 'string' &&
		typeof value.expiresAt === 'number'
	);
}

function isPreviewAccessCookiePayload(value: unknown): value is PreviewAccessCookiePayload {
	return (
		isRecord(value) &&
		typeof value.projectId === 'string' &&
		typeof value.previewToken === 'string' &&
		typeof value.previewOrigin === 'string' &&
		typeof value.organizationId === 'string' &&
		typeof value.userId === 'string' &&
		typeof value.expiresAt === 'number'
	);
}

async function signPreviewPayload<T extends PreviewAccessGrantPayload | PreviewAccessCookiePayload>(
	purpose: 'grant' | 'cookie',
	payload: T,
	secret: string,
): Promise<string> {
	const encodedPayload = encodeBase64Url(JSON.stringify(payload));
	const signature = await hmacBase64Url(secret, `${purpose}.${encodedPayload}`);
	return `${encodedPayload}.${signature}`;
}

async function verifyPreviewPayload(purpose: 'grant' | 'cookie', token: string, secret: string): Promise<unknown> {
	const dotIndex = token.lastIndexOf('.');
	if (dotIndex <= 0) {
		return undefined;
	}

	const envelope: PreviewAccessEnvelope = {
		payload: token.slice(0, dotIndex),
		signature: token.slice(dotIndex + 1),
	};
	const expectedSignature = await hmacBase64Url(secret, `${purpose}.${envelope.payload}`);
	if (!(await constantTimeEqual(expectedSignature, envelope.signature))) {
		return undefined;
	}

	const decodedPayload = decodeBase64Url(envelope.payload);
	if (!decodedPayload) {
		return undefined;
	}

	try {
		return JSON.parse(decodedPayload);
	} catch {
		return undefined;
	}
}

function readCookie(headers: Headers, name: string): string | undefined {
	const cookieHeader = headers.get('Cookie');
	if (!cookieHeader) {
		return undefined;
	}

	for (const chunk of cookieHeader.split(';')) {
		const [rawName, ...rest] = chunk.trim().split('=');
		if (rawName !== name) {
			continue;
		}
		const value = rest.join('=');
		try {
			return value.length > 0 ? decodeURIComponent(value) : undefined;
		} catch {
			return undefined;
		}
	}

	return undefined;
}

function isNotExpired(expiresAt: number): boolean {
	return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

export function buildPreviewAccessBootstrapUrl(appOrigin: string, projectId: string, returnTo: string): string {
	const bootstrapUrl = new URL(`/p/${projectId}/__preview-auth/bootstrap`, appOrigin);
	bootstrapUrl.searchParams.set('returnTo', returnTo);
	return bootstrapUrl.toString();
}

export function buildPreviewAccessLoginUrl(appOrigin: string, next: string): string {
	const loginUrl = new URL('/', appOrigin);
	loginUrl.searchParams.set('next', next);
	return loginUrl.toString();
}

export function buildPreviewRedeemUrl(previewOrigin: string, grantToken: string): string {
	const redeemUrl = new URL(PREVIEW_ACCESS_REDEEM_PATH, previewOrigin);
	redeemUrl.searchParams.set('grant', grantToken);
	return redeemUrl.toString();
}

export function getRedirectPath(url: URL): string {
	const redirectPath = `${url.pathname}${url.search}`;
	if (url.pathname.startsWith(PREVIEW_ACCESS_PREFIX)) {
		return '/';
	}
	return redirectPath || '/';
}

export function isNavigationRequest(request: Request): boolean {
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return false;
	}

	const fetchMode = request.headers.get('Sec-Fetch-Mode');
	if (fetchMode === 'navigate') {
		return true;
	}

	const fetchDestination = request.headers.get('Sec-Fetch-Dest');
	if (fetchDestination === 'document' || fetchDestination === 'iframe') {
		return true;
	}

	const accept = request.headers.get('Accept') ?? '';
	return accept.includes('text/html');
}

export function serializePreviewAccessCookie(token: string): string {
	return serialize(PREVIEW_ACCESS_COOKIE_NAME, token, {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: 'None',
		partitioned: true,
		maxAge: PREVIEW_ACCESS_COOKIE_MAX_AGE_SECONDS,
	});
}

export async function createPreviewAccessGrant(payload: Omit<PreviewAccessGrantPayload, 'expiresAt'>, secret: string): Promise<string> {
	return signPreviewPayload(
		'grant',
		{
			...payload,
			expiresAt: Date.now() + PREVIEW_ACCESS_GRANT_MAX_AGE_SECONDS * 1000,
		},
		secret,
	);
}

export async function readPreviewAccessGrant(token: string, secret: string): Promise<PreviewAccessGrantPayload | undefined> {
	const payload = await verifyPreviewPayload('grant', token, secret);
	if (!isPreviewAccessGrantPayload(payload) || !isNotExpired(payload.expiresAt)) {
		return undefined;
	}
	return payload;
}

export async function createPreviewAccessCookieToken(
	payload: Omit<PreviewAccessCookiePayload, 'expiresAt'>,
	secret: string,
): Promise<string> {
	return signPreviewPayload(
		'cookie',
		{
			...payload,
			expiresAt: Date.now() + PREVIEW_ACCESS_COOKIE_MAX_AGE_SECONDS * 1000,
		},
		secret,
	);
}

export async function readPreviewAccessCookie(
	headers: Headers,
	secret: string,
	expectedProjectId: string,
	expectedPreviewToken: string,
	previewUrl: URL,
	expectedOrganizationId: string,
): Promise<PreviewAccessCookiePayload | undefined> {
	const token = readCookie(headers, PREVIEW_ACCESS_COOKIE_NAME);
	if (!token) {
		return undefined;
	}

	const payload = await verifyPreviewPayload('cookie', token, secret);
	if (!isPreviewAccessCookiePayload(payload) || !isNotExpired(payload.expiresAt)) {
		return undefined;
	}
	if (
		payload.projectId !== expectedProjectId ||
		payload.previewToken !== expectedPreviewToken ||
		payload.previewOrigin !== previewUrl.origin ||
		payload.organizationId !== expectedOrganizationId
	) {
		return undefined;
	}
	return payload;
}
