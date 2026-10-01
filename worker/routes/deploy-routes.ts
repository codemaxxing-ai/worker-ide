import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import { HttpErrorCode } from '@shared/http-errors';
import { deployRequestSchema } from '@shared/validation';

import * as schema from '../db/auth-schema';
import { getConnection } from '../lib/cloudflare-oauth';
import { getOrCreateTemporaryAccount } from '../lib/cloudflare-temporary-account';
import { httpError } from '../lib/http-error';
import { readProjectName } from '../lib/protected-files';
import { sanitizeWorkerName } from '../workflows/deploy-helpers';

import type { AppEnvironment } from '../types';
import type { DeployResult, DeployStatusResponse, DeployWorkflowParameters } from '@shared/deploy-types';

const WORKFLOW_JARGON_PATTERNS = [
	/^NonRetryableError$/i,
	/^WorkflowFatalError$/i,
	/the execution of the workflow instance was terminated/i,
	/a step threw a?n? ?NonRetryableError/i,
];

function sanitizeDeployError(message: string | undefined): string | undefined {
	if (!message) {
		return undefined;
	}

	for (const pattern of WORKFLOW_JARGON_PATTERNS) {
		if (pattern.test(message)) {
			return 'An unexpected error occurred during deployment. Please try again.';
		}
	}

	return message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object';
}

function parseDeployResult(value: unknown): DeployResult | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	if (typeof value.workerName !== 'string') {
		return undefined;
	}

	return {
		success: value.success === true,
		workerName: value.workerName,
		workerUrl: typeof value.workerUrl === 'string' ? value.workerUrl : undefined,
		dashboardUrl: typeof value.dashboardUrl === 'string' ? value.dashboardUrl : undefined,
		claimUrl: typeof value.claimUrl === 'string' ? value.claimUrl : undefined,
		claimExpiresAt: typeof value.claimExpiresAt === 'string' ? value.claimExpiresAt : undefined,
		error: typeof value.error === 'string' && value.error.trim() !== '' ? value.error : undefined,
	};
}

export const deployRoutes = new Hono<AppEnvironment>()
	.post('/deploy', zValidator('json', deployRequestSchema), async (c) => {
		const request = c.req.valid('json');
		const userId = c.get('session').userId;

		const database = drizzle(c.env.DB, { schema });
		const projectRows = await database
			.select({ organizationId: schema.project.organizationId })
			.from(schema.project)
			.where(eq(schema.project.id, c.get('projectId')))
			.limit(1);
		const organizationId = projectRows[0]?.organizationId;
		if (!organizationId) {
			throw httpError(HttpErrorCode.NOT_FOUND, 'Project not found');
		}

		if (request.mode === 'temporary') {
			const connection = await getConnection({ DB: c.env.DB }, userId);
			if (connection) {
				throw httpError(HttpErrorCode.VALIDATION_ERROR, 'Disconnect your Cloudflare account before deploying to a new temporary account');
			}
		}
		let accountId: string;
		if (request.mode === 'temporary') {
			const temporaryAccount = await getOrCreateTemporaryAccount(c.env, userId, c.get('projectId'));
			accountId = temporaryAccount.accountId;
		} else {
			if (!request.accountId) {
				throw httpError(HttpErrorCode.VALIDATION_ERROR, 'Cloudflare account ID is required');
			}
			accountId = request.accountId.trim();
		}
		if (request.mode === 'permanent') {
			// Permanent-account deployments rely on the user's OAuth connection.
			const connection = await getConnection({ DB: c.env.DB }, userId);
			if (!connection) {
				throw httpError(HttpErrorCode.VALIDATION_ERROR, 'Connect your Cloudflare account before deploying');
			}
		}

		const projectName = await readProjectName(c.get('projectRoot'));
		const sanitizedWorkerName = sanitizeWorkerName(request.workerName || projectName);
		const instanceId = crypto.randomUUID();
		const parameters: DeployWorkflowParameters = {
			accountId,
			mode: request.mode,
			workerName: sanitizedWorkerName,
			projectId: c.get('projectId'),
			projectRoot: c.get('projectRoot'),
			organizationId,
			userId,
			requestStartedAt: Date.now(),
		};

		await c.env.DEPLOY_WORKFLOW.create({ id: instanceId, params: parameters });

		return c.json({ instanceId });
	})
	.get('/deploy/status', async (c) => {
		const instanceId = c.req.query('instanceId');
		if (!instanceId) {
			throw httpError(HttpErrorCode.VALIDATION_ERROR, 'Missing deployment instance ID');
		}

		const workflowInstance = await c.env.DEPLOY_WORKFLOW.get(instanceId);
		const workflowStatus = await workflowInstance.status();
		const result = parseDeployResult(workflowStatus.output);
		return c.json({
			instanceId,
			status: workflowStatus.status === 'rollingBack' ? 'running' : workflowStatus.status,
			result: result?.success ? result : undefined,
			error: sanitizeDeployError(result?.error ?? workflowStatus.error?.message),
		} satisfies DeployStatusResponse);
	});

export {
	extractFrontendEntryPoint,
	generateProductionHtml,
	hashFileForManifest,
	isConfigFile,
	isSourceFile,
	sanitizeR2BucketName,
	sanitizeWorkerName,
} from '../workflows/deploy-helpers';

export type DeployRoutes = typeof deployRoutes;
