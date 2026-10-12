import { Hono } from 'hono';

import { buildGitOrigin } from '@shared/domain';
import { HttpErrorCode } from '@shared/http-errors';

import { getDomainConfiguration } from '../lib/domain-configuration';
import { signGitToken } from '../lib/git-token';
import { httpError } from '../lib/http-error';

import type { AppEnvironment } from '../types';

const GIT_NAMESPACE = 'ide';

export const gitCredentialRoutes = new Hono<AppEnvironment>()
	.get('/git/remote', (c) => {
		const projectId = c.get('projectId');
		const gitOrigin = buildGitOrigin(getDomainConfiguration(c.env).appOrigin);
		const repoId = `${GIT_NAMESPACE}/${projectId}`;

		return c.json({
			cloneUrl: `${gitOrigin}/${repoId}`,
			repoId,
		});
	})

	/**
	 * POST /api/git/credentials — Generate a short-lived read-only git token.
	 *
	 * The token authorizes clone/fetch through our `git.<domain>` proxy, which
	 * verifies it and mints a real Cloudflare Artifacts token before forwarding:
	 *   git clone https://x:<token>@git.<domain>/ide/<projectId>
	 */
	.post('/git/credentials', async (c) => {
		const projectId = c.get('projectId');
		const gitOrigin = buildGitOrigin(getDomainConfiguration(c.env).appOrigin);
		const repoId = `${GIT_NAMESPACE}/${projectId}`;

		try {
			const { token, expiresAt } = await signGitToken(c.env.BETTER_AUTH_SECRET, {
				projectId,
				scope: 'read',
			});

			return c.json({
				token,
				expiresAt,
				cloneUrl: `${gitOrigin}/${repoId}`,
				username: 'x',
			});
		} catch (error) {
			console.error('Failed to mint git token:', error);
			throw httpError(HttpErrorCode.INTERNAL_ERROR, 'Failed to generate git credentials');
		}
	});

export type GitCredentialRoutes = typeof gitCredentialRoutes;
