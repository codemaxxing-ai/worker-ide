import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';

import { CLOUDFLARE_OAUTH_CALLBACK_PATH, CLOUDFLARE_OAUTH_STATE_COOKIE, CLOUDFLARE_OAUTH_STATE_TTL_SECONDS } from '@shared/constants';
import { HttpErrorCode } from '@shared/http-errors';

import {
	buildAuthorizationUrl,
	deleteConnection,
	deriveCodeChallenge,
	exchangeCodeForTokens,
	fetchCloudflareEmail,
	generateCodeVerifier,
	generateState,
	getConnection,
	getValidAccessToken,
	listAccounts,
	revokeToken,
	storeConnection,
} from '../lib/cloudflare-oauth';
import { decryptToken } from '../lib/cloudflare-oauth-crypto';
import { getDomainConfiguration } from '../lib/domain-configuration';
import { httpError } from '../lib/http-error';

import type { CloudflareOAuthEnvironment } from '../lib/cloudflare-oauth';
import type { AuthedEnvironment } from '../types';
import type { CloudflareAccountsResponse, CloudflareConnectionStatus } from '@shared/deploy-types';

interface OAuthStatePayload {
	state: string;
	codeVerifier: string;
}

function getOAuthEnvironment(c: { env: Env }): CloudflareOAuthEnvironment {
	const { CLOUDFLARE_OAUTH_CLIENT_ID, CLOUDFLARE_OAUTH_CLIENT_SECRET } = c.env;
	if (!CLOUDFLARE_OAUTH_CLIENT_ID || !CLOUDFLARE_OAUTH_CLIENT_SECRET) {
		throw httpError(HttpErrorCode.INTERNAL_ERROR, 'Cloudflare OAuth is not configured on this server');
	}
	return {
		DB: c.env.DB,
		BETTER_AUTH_SECRET: c.env.BETTER_AUTH_SECRET,
		CLOUDFLARE_OAUTH_CLIENT_ID,
		CLOUDFLARE_OAUTH_CLIENT_SECRET,
	};
}

function getRedirectUri(): string {
	const appOrigin = getDomainConfiguration(env).appOrigin;
	return `${appOrigin}${CLOUDFLARE_OAUTH_CALLBACK_PATH}`;
}

/**
 * Minimal HTML page returned by the callback. It notifies the opener window
 * (the deploy modal) and closes the popup. Falls back to a self-redirect for
 * non-popup flows.
 */
function callbackResultPage(status: 'success' | 'error', message?: string): string {
	const payload = JSON.stringify({ type: 'cloudflare-oauth', status, message: message ?? '' });
	return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Cloudflare connection</title></head>
<body style="font-family: system-ui, sans-serif; padding: 24px;">
<p>${status === 'success' ? 'Cloudflare account connected. You can close this window.' : 'Connection failed.'}</p>
<script>
(function () {
  try {
    if (window.opener) {
      window.opener.postMessage(${payload}, window.location.origin);
    }
  } catch (error) {}
  window.close();
})();
</script>
</body>
</html>`;
}

export const cloudflareOAuthRoutes = new Hono<AuthedEnvironment>()
	/**
	 * GET /api/cloudflare/oauth/connect — Begin the OAuth flow.
	 *
	 * Generates PKCE + state, stores them in a short-lived signed cookie, and
	 * redirects the browser to Cloudflare's consent page.
	 */
	.get('/cloudflare/oauth/connect', async (c) => {
		const environment = getOAuthEnvironment(c);
		const state = generateState();
		const codeVerifier = generateCodeVerifier();
		const codeChallenge = await deriveCodeChallenge(codeVerifier);

		const statePayload: OAuthStatePayload = { state, codeVerifier };
		await setSignedCookie(c, CLOUDFLARE_OAUTH_STATE_COOKIE, JSON.stringify(statePayload), c.env.BETTER_AUTH_SECRET, {
			path: CLOUDFLARE_OAUTH_CALLBACK_PATH,
			httpOnly: true,
			secure: new URL(c.req.url).protocol === 'https:',
			sameSite: 'Lax',
			maxAge: CLOUDFLARE_OAUTH_STATE_TTL_SECONDS,
		});

		const authorizationUrl = buildAuthorizationUrl({
			clientId: environment.CLOUDFLARE_OAUTH_CLIENT_ID,
			redirectUri: getRedirectUri(),
			state,
			codeChallenge,
		});

		return c.redirect(authorizationUrl);
	})

	/**
	 * GET /api/cloudflare/oauth/callback — OAuth redirect target.
	 *
	 * Validates state, exchanges the code for tokens, stores them encrypted, and
	 * returns a page that closes the popup.
	 */
	.get('/cloudflare/oauth/callback', async (c) => {
		const environment = getOAuthEnvironment(c);
		const cookieValue = await getSignedCookie(c, c.env.BETTER_AUTH_SECRET, CLOUDFLARE_OAUTH_STATE_COOKIE);
		deleteCookie(c, CLOUDFLARE_OAUTH_STATE_COOKIE, { path: CLOUDFLARE_OAUTH_CALLBACK_PATH });

		const renderError = (message: string) => c.html(callbackResultPage('error', message), 400);

		const oauthError = c.req.query('error');
		if (oauthError) {
			return renderError(oauthError);
		}

		const code = c.req.query('code');
		const returnedState = c.req.query('state');
		if (!code || !returnedState) {
			return renderError('Missing authorization code');
		}

		if (!cookieValue) {
			return renderError('Authorization session expired. Please try again.');
		}

		let statePayload: OAuthStatePayload;
		try {
			statePayload = JSON.parse(cookieValue);
		} catch {
			return renderError('Invalid authorization session');
		}

		if (statePayload.state !== returnedState) {
			return renderError('State mismatch. Please try again.');
		}

		try {
			const tokenResponse = await exchangeCodeForTokens(environment, {
				code,
				codeVerifier: statePayload.codeVerifier,
				redirectUri: getRedirectUri(),
			});
			const email = await fetchCloudflareEmail(tokenResponse.access_token);
			await storeConnection(environment, c.get('session').userId, tokenResponse, { email });
			return c.html(callbackResultPage('success'));
		} catch (error) {
			console.error('Cloudflare OAuth callback failed:', error);
			return renderError('Failed to complete Cloudflare authorization');
		}
	})

	/**
	 * GET /api/cloudflare/connection — Whether the user has linked Cloudflare.
	 */
	.get('/cloudflare/connection', async (c) => {
		const connection = await getConnection({ DB: c.env.DB }, c.get('session').userId);
		return c.json({
			connected: connection !== undefined,
			email: connection?.cloudflareEmail ?? undefined,
		} satisfies CloudflareConnectionStatus);
	})

	/**
	 * GET /api/cloudflare/accounts — Accounts the user can deploy into.
	 */
	.get('/cloudflare/accounts', async (c) => {
		const environment = getOAuthEnvironment(c);
		const accessToken = await getValidAccessToken(environment, c.get('session').userId);
		if (!accessToken) {
			throw httpError(HttpErrorCode.VALIDATION_ERROR, 'Cloudflare account is not connected');
		}

		try {
			const accounts = await listAccounts(accessToken);
			return c.json({ accounts } satisfies CloudflareAccountsResponse);
		} catch (error) {
			console.error('Failed to list Cloudflare accounts:', error);
			throw httpError(HttpErrorCode.UPSTREAM_ERROR, 'Failed to list Cloudflare accounts');
		}
	})

	/**
	 * POST /api/cloudflare/disconnect — Revoke + remove the connection.
	 */
	.post('/cloudflare/disconnect', async (c) => {
		const userId = c.get('session').userId;
		const environment = getOAuthEnvironment(c);
		const connection = await getConnection({ DB: c.env.DB }, userId);

		if (connection) {
			const accessToken = await decryptToken(c.env.BETTER_AUTH_SECRET, connection.accessTokenEncrypted);
			if (accessToken) {
				await revokeToken(environment, accessToken);
			}
			await deleteConnection({ DB: c.env.DB }, userId);
		}

		return c.json({ success: true });
	});

export type CloudflareOAuthRoutes = typeof cloudflareOAuthRoutes;
