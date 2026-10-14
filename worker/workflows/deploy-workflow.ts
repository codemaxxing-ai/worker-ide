import { Buffer } from 'node:buffer';

import { WorkflowEntrypoint } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

import { SNAPSHOT_EXCLUDED_DIRECTORIES } from '@shared/constants';
import { sanitizeR2BucketName } from '@shared/deploy-helpers';
import { isWorkerResourceLimit, WorkerResourceLimitError } from '@shared/worker-resource-budget';

import {
	bundleFrontend,
	bundleWorker,
	enableWorkersDevelopmentSubdomain,
	ensureR2Bucket,
	entriesToStaticAssets,
	getWorkersDevelopmentUrl,
	readProjectBuildInputs,
	uploadStaticAssets,
	uploadWorkerModules,
	uploadWorkerScript,
	type ProjectBuildInputs,
} from './deploy-helpers';
import { trackProjectEvent } from '../lib/analytics';
import { getValidAccessToken } from '../lib/cloudflare-oauth';
import { getTemporaryAccount } from '../lib/cloudflare-temporary-account';
import { filesystemNamespace } from '../lib/durable-object-namespaces';
import { runWithProjectStub } from '../lib/project-fs';
import { toDurableObjectId } from '../lib/project-id';
import { withSpan } from '../lib/tracing';
import { getBuildArtifact } from '../services/vite-host/build-artifact-client';
import { selectRuntime } from '../services/vite-host/runtimes/registry';

import type { DeployResult, DeployWorkflowParameters } from '@shared/deploy-types';
import type { RuntimeDecision } from '@shared/runtime-status';
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers';

const BUILD_STEP_CONFIG: WorkflowStepConfig = {
	retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
	timeout: '5 minutes',
};

const CLOUDFLARE_API_STEP_CONFIG: WorkflowStepConfig = {
	retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
	timeout: '10 minutes',
};

const SHORT_CLOUDFLARE_API_STEP_CONFIG: WorkflowStepConfig = {
	retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
	timeout: '5 minutes',
};

// The vinext build + asset/script uploads run together in one step (so the
// large bundle is never persisted as step state); allow ample time for both.
const VINEXT_DEPLOY_STEP_CONFIG: WorkflowStepConfig = {
	retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
	timeout: '10 minutes',
};

function extractErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	// Never surface an empty string: some errors (e.g. a Hono HTTPException built
	// only from a `res` body) have an empty `.message`, which would otherwise
	// reach the user as a blank deploy error.
	return message.trim() === '' ? 'Deploy failed with an unknown error' : message;
}

function toNonRetryableError(error: unknown): Error {
	return new NonRetryableError(isWorkerResourceLimit(error) ? new WorkerResourceLimitError().message : extractErrorMessage(error));
}

export class DeployWorkflow extends WorkflowEntrypoint<Env, DeployWorkflowParameters> {
	/**
	 * Resolve a valid Cloudflare access token for the deploying user, refreshing
	 * it if needed. Fetched fresh inside each Cloudflare API step so long-running
	 * or retried deploys never use an expired token. The token is never stored in
	 * workflow step output.
	 */
	private async resolveAccessToken(parameters: DeployWorkflowParameters): Promise<string> {
		if (parameters.mode === 'temporary') {
			const account = await getTemporaryAccount(this.env, parameters.userId, parameters.projectId, parameters.accountId);
			if (!account) {
				throw new NonRetryableError('The temporary Cloudflare account has expired. Deploy again to create a new account.');
			}
			return account.accessToken;
		}
		const accessToken = await getValidAccessToken(
			{
				DB: this.env.DB,
				BETTER_AUTH_SECRET: this.env.BETTER_AUTH_SECRET,
				CLOUDFLARE_OAUTH_CLIENT_ID: this.env.CLOUDFLARE_OAUTH_CLIENT_ID,
				CLOUDFLARE_OAUTH_CLIENT_SECRET: this.env.CLOUDFLARE_OAUTH_CLIENT_SECRET,
			},
			parameters.userId,
		);
		if (!accessToken) {
			throw new NonRetryableError('Cloudflare account is not connected. Please reconnect and try again.');
		}
		return accessToken;
	}

	async run(event: WorkflowEvent<DeployWorkflowParameters>, step: WorkflowStep): Promise<DeployResult> {
		const parameters = event.payload;
		const filesystemId = toDurableObjectId(filesystemNamespace, parameters.projectId);
		const filesystemStub = filesystemNamespace.get(filesystemId);
		let decision: RuntimeDecision | undefined;

		try {
			const { inputs, snapshotHash } = await step.do('read-project-config', async () => {
				const snapshotHash = await filesystemStub.snapshotHash(SNAPSHOT_EXCLUDED_DIRECTORIES);
				const inputs = await runWithProjectStub(
					filesystemStub,
					async () => readProjectBuildInputs(parameters.projectRoot),
					parameters.projectRoot,
				);
				if (snapshotHash !== (await filesystemStub.snapshotHash(SNAPSHOT_EXCLUDED_DIRECTORIES)))
					throw new NonRetryableError('Project changed while reading build inputs. Start a new deployment.');
				return { inputs, snapshotHash };
			});

			decision = await filesystemStub.getBuildRuntimeDecision(inputs.allFiles);
			await filesystemStub.reportRuntimeStatus('build', decision, 'starting');
			const runtime = selectRuntime({ files: inputs.allFiles }, decision.backend);
			if (runtime.hosting === 'container') await this.bundleAndUploadNative(step, parameters, filesystemStub, inputs, snapshotHash);
			else {
				try {
					await (runtime.hosting === 'artifact'
						? this.bundleAndUploadRuntime(step, parameters, inputs, runtime.id)
						: this.bundleAndUploadStatic(step, parameters, filesystemStub, inputs));
				} catch (error) {
					// Only compiler failures are tagged. Upload failures do not restart builds.
					if (!(error instanceof Error) || !error.message.includes('WORKER_RESOURCE_LIMIT') || decision.reason === 'explicit-choice')
						throw error;
					decision = await filesystemStub.promoteBuildRuntime('build');
					await this.bundleAndUploadNative(step, parameters, filesystemStub, inputs, snapshotHash);
				}
			}
			await filesystemStub.reportRuntimeStatus('build', decision, 'ready');

			await step.do('enable-subdomain', SHORT_CLOUDFLARE_API_STEP_CONFIG, async () => {
				const accessToken = await this.resolveAccessToken(parameters);
				return enableWorkersDevelopmentSubdomain(parameters.accountId, accessToken, parameters.workerName);
			});

			const workerUrl = await step.do('get-worker-url', SHORT_CLOUDFLARE_API_STEP_CONFIG, async () => {
				const accessToken = await this.resolveAccessToken(parameters);
				return getWorkersDevelopmentUrl(parameters.accountId, accessToken, parameters.workerName);
			});

			const temporaryAccount =
				parameters.mode === 'temporary'
					? await getTemporaryAccount(this.env, parameters.userId, parameters.projectId, parameters.accountId)
					: undefined;
			const result: DeployResult = {
				success: true,
				workerName: parameters.workerName,
				workerUrl,
				dashboardUrl:
					parameters.mode === 'permanent'
						? `https://dash.cloudflare.com/${parameters.accountId}/workers/services/view/${parameters.workerName}`
						: undefined,
				claimUrl: temporaryAccount?.claimUrl,
				claimExpiresAt: temporaryAccount?.expiresAt.toISOString(),
			};

			trackProjectEvent({
				organizationId: parameters.organizationId,
				eventType: 'deploy',
				projectId: parameters.projectId,
				userId: parameters.userId,
				detail: parameters.workerName,
				durationMs: Date.now() - parameters.requestStartedAt,
				success: true,
			});

			return result;
		} catch (error) {
			if (decision) await filesystemStub.reportRuntimeStatus('build', decision, 'error');
			const message = extractErrorMessage(error);
			trackProjectEvent({
				organizationId: parameters.organizationId,
				eventType: 'deploy',
				projectId: parameters.projectId,
				userId: parameters.userId,
				error: message,
				durationMs: Date.now() - parameters.requestStartedAt,
				success: false,
			});
			return { success: false, workerName: parameters.workerName, error: message };
		}
	}

	private async bundleAndUploadNative(
		step: WorkflowStep,
		parameters: DeployWorkflowParameters,
		filesystemStub: ReturnType<typeof filesystemNamespace.get>,
		inputs: ProjectBuildInputs,
		snapshotHash: string,
	): Promise<void> {
		const r2BucketName = await this.ensureProjectR2Bucket(step, parameters, inputs);
		await step.do('build-and-deploy-native', { ...VINEXT_DEPLOY_STEP_CONFIG, retries: { limit: 0, delay: '1 second' } }, async () => {
			try {
				using build = await filesystemStub.nativeBuild(snapshotHash);
				if (
					!build.serverModules &&
					Object.keys(inputs.allFiles).some((filename) => /^(?:worker\/index\.m?[jt]s|(?:src\/)?index\.[jt]s)$/.test(filename))
				)
					throw new Error('Native build did not produce the Worker entry. Retry after the container runtime updates.');
				const staticAssets = new Map<string, Uint8Array>(
					Object.entries(build.clientFiles).map(([filename, bytes]) => [`/${filename}`, Buffer.from(bytes, 'base64')]),
				);
				const accessToken = await this.resolveAccessToken(parameters);
				const assetsCompletionJwt =
					staticAssets.size > 0
						? await uploadStaticAssets(parameters.accountId, accessToken, parameters.workerName, staticAssets)
						: undefined;
				if (build.serverModules && build.mainModule) {
					await uploadWorkerModules({
						accountId: parameters.accountId,
						accessToken,
						workerName: parameters.workerName,
						mainModule: build.mainModule,
						modules: Object.entries(build.serverModules).map(([name, contents]) => ({ name, contents })),
						assetsCompletionJwt,
						assetSettings: inputs.assetSettings,
						r2BucketName,
					});
					return;
				}
				const workerCode = 'export default { fetch() { return new Response("Not found", { status: 404 }); } };';
				await uploadWorkerScript(
					parameters.accountId,
					accessToken,
					parameters.workerName,
					workerCode,
					assetsCompletionJwt,
					inputs.assetSettings,
					r2BucketName,
				);
			} catch (error) {
				throw toNonRetryableError(error);
			}
		});
	}

	/**
	 * Standard project deploy: bundle the worker entry + frontend, upload static
	 * assets, ensure the R2 bucket, then upload the single-module worker script.
	 */
	private async bundleAndUploadStatic(
		step: WorkflowStep,
		parameters: DeployWorkflowParameters,
		filesystemStub: ReturnType<typeof filesystemNamespace.get>,
		inputs: ProjectBuildInputs,
	): Promise<void> {
		const workerBundle = await step.do('bundle-worker', BUILD_STEP_CONFIG, async () =>
			runWithProjectStub(
				filesystemStub,
				async () => {
					try {
						return await bundleWorker(parameters.projectRoot, inputs);
					} catch (error) {
						throw toNonRetryableError(error);
					}
				},
				parameters.projectRoot,
			),
		);

		const frontendBundle = await step.do('bundle-frontend', BUILD_STEP_CONFIG, async () =>
			runWithProjectStub(
				filesystemStub,
				async () => {
					try {
						return await bundleFrontend(parameters.projectRoot, inputs);
					} catch (error) {
						throw toNonRetryableError(error);
					}
				},
				parameters.projectRoot,
			),
		);

		const staticAssets = entriesToStaticAssets(frontendBundle.staticAssetsEntries);
		let assetsCompletionJwt: string | undefined;
		if (staticAssets.size > 0) {
			assetsCompletionJwt = await step.do('upload-assets', CLOUDFLARE_API_STEP_CONFIG, async () => {
				const accessToken = await this.resolveAccessToken(parameters);
				return uploadStaticAssets(parameters.accountId, accessToken, parameters.workerName, staticAssets);
			});
		}

		const r2BucketName = await this.ensureProjectR2Bucket(step, parameters, inputs);

		await step.do('upload-worker-script', CLOUDFLARE_API_STEP_CONFIG, async () => {
			const accessToken = await this.resolveAccessToken(parameters);
			return uploadWorkerScript(
				parameters.accountId,
				accessToken,
				parameters.workerName,
				workerBundle.workerCode,
				assetsCompletionJwt,
				inputs.assetSettings,
				r2BucketName,
			);
		});
	}

	/**
	 * Framework-runtime deploy (vinext, plain React, …): retrieve the production
	 * server module set + client assets from the stateless build-artifact cache,
	 * then upload the client output as static assets and the server module set as
	 * a multi-module worker. The build + uploads happen inside a single step so the
	 * multi-megabyte bundle is never persisted as workflow step state (only the
	 * project source crosses step boundaries).
	 */
	private async bundleAndUploadRuntime(
		step: WorkflowStep,
		parameters: DeployWorkflowParameters,
		inputs: ProjectBuildInputs,
		runtimeId: string,
	): Promise<void> {
		const r2BucketName = await this.ensureProjectR2Bucket(step, parameters, inputs);

		await step.do('build-and-deploy-runtime', VINEXT_DEPLOY_STEP_CONFIG, async () => {
			let build;
			try {
				const filesystemStub = filesystemNamespace.get(toDurableObjectId(filesystemNamespace, parameters.projectId));
				const snapshotHash = await filesystemStub.snapshotHash(SNAPSHOT_EXCLUDED_DIRECTORIES);
				build = await withSpan(
					'deploy.buildRuntime',
					() =>
						getBuildArtifact({
							projectId: parameters.projectId,
							projectRoot: parameters.projectRoot,
							runtimeId,
							mode: 'deploy',
							snapshotHash,
						}),
					{ 'project.id': parameters.projectId, 'runtime.id': runtimeId, 'worker.name': parameters.workerName },
				);
			} catch (error) {
				throw toNonRetryableError(error);
			}

			const accessToken = await this.resolveAccessToken(parameters);
			const staticAssets = new Map<string, Uint8Array>(
				Object.entries(build.clientOutput).map(([path, contents]) => [`/${path}`, new TextEncoder().encode(contents)]),
			);
			const assetsCompletionJwt =
				staticAssets.size > 0
					? await uploadStaticAssets(parameters.accountId, accessToken, parameters.workerName, staticAssets)
					: undefined;

			await uploadWorkerModules({
				accountId: parameters.accountId,
				accessToken,
				workerName: parameters.workerName,
				mainModule: build.mainModule,
				modules: Object.entries(build.serverModules).map(([name, contents]) => ({ name, contents })),
				assetsCompletionJwt,
				assetSettings: inputs.assetSettings,
				r2BucketName,
			});
		});
	}

	/** Ensure the project's R2 bucket exists when storage is enabled. */
	private async ensureProjectR2Bucket(
		step: WorkflowStep,
		parameters: DeployWorkflowParameters,
		inputs: ProjectBuildInputs,
	): Promise<string | undefined> {
		if (!inputs.bindingsConfig.storage) {
			return undefined;
		}
		if (parameters.mode === 'temporary') {
			throw new NonRetryableError(
				'Temporary Cloudflare accounts do not support R2 storage. Connect a Cloudflare account to deploy this project.',
			);
		}
		const bucketName = sanitizeR2BucketName(parameters.workerName);
		await step.do('ensure-r2-bucket', SHORT_CLOUDFLARE_API_STEP_CONFIG, async () => {
			const accessToken = await this.resolveAccessToken(parameters);
			return ensureR2Bucket(parameters.accountId, accessToken, bucketName);
		});
		return bucketName;
	}
}
