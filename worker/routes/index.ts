import { Hono } from 'hono';

import { agentRoutes } from './agent-routes';
import { deployRoutes } from './deploy-routes';
import { fileRoutes } from './file-routes';
import { gitCredentialRoutes } from './git-credential-routes';
import { gitRoutes } from './git-routes';
import { imageRoutes } from './image-routes';
import { lintRoutes } from './lint-routes';
import { previewUrlRoutes } from './preview-url-routes';
import { projectRoutes } from './project-routes';
import { reviewRoutes } from './review-routes';
import { snapshotRoutes } from './snapshot-routes';
import { sttRoutes } from './stt-routes';
import { testRoutes } from './test-routes';
import { transformRoutes } from './transform-routes';

import type { AppEnvironment } from '../types';

/**
 * Combined API routes with full type information for Hono RPC.
 * All routes are prefixed with /api by the main app.
 */
export const apiRoutes = new Hono<AppEnvironment>()
	.route('', fileRoutes)
	.route('', projectRoutes)
	.route('', previewUrlRoutes)
	.route('', reviewRoutes)
	.route('', snapshotRoutes)
	.route('', agentRoutes)
	.route('', imageRoutes)
	.route('', transformRoutes)
	.route('', lintRoutes)
	.route('', gitRoutes)
	.route('', gitCredentialRoutes)
	.route('', testRoutes)
	.route('', deployRoutes)
	.route('', sttRoutes);

/**
 * Export the full API routes type for client-side type inference.
 * This type is used by the Hono RPC client to provide type-safe API calls.
 */
export type ApiRoutes = typeof apiRoutes;

export type { UserRoutes } from './user-routes';
export type { OrgRoutes } from './org-routes';
export type { TransferRoutes } from './transfer-routes';
export type { CloudflareOAuthRoutes } from './cloudflare-oauth-routes';
export type { RootApiRoutes } from './root-routes';
