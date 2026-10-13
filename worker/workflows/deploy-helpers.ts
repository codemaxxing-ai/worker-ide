import { z } from 'zod';

import { HIDDEN_ENTRIES, WORKERS_COMPATIBILITY_DATE } from '@shared/constants';
import { HttpErrorCode } from '@shared/http-errors';
import { parseJsonc } from '@shared/jsonc';
import { resolveAssetSettings } from '@shared/types';
import { fs } from '@worker/lib/project-fs';

import { getContentType } from '../lib/content-type';
import { httpError } from '../lib/http-error';
import { readAssetSettings, readBindingsConfig, readDependencies, readProjectName } from '../lib/protected-files';
import { withSpan } from '../lib/tracing';
import { bundleWithCdn } from '../services/bundler-client';
import { toEsbuildTsconfigRaw } from '../services/transform-service';

import type { AssetSettings } from '@shared/types';

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

const assetUploadSessionResponseSchema = z.object({
	result: z
		.object({
			jwt: z.string().optional(),
			buckets: z.array(z.array(z.string())).optional(),
		})
		.optional(),
});

const assetUploadResponseSchema = z.object({
	result: z
		.object({
			jwt: z.string().optional(),
		})
		.optional(),
});

const workersSubdomainResponseSchema = z.object({
	result: z
		.object({
			subdomain: z.string().optional(),
		})
		.optional(),
});

export interface ProjectBuildInputs {
	projectName: string;
	assetSettings: AssetSettings | undefined;
	bindingsConfig: { storage?: boolean };
	registeredDependencies: Map<string, string>;
	tsconfigRaw: string | undefined;
	allFiles: Record<string, string>;
}

export interface WorkerBundleResult {
	workerCode: string;
}

export interface FrontendBundleResult {
	staticAssetsEntries: Array<[string, number[]]>;
}

function parseUpstreamResponse<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		throw httpError(HttpErrorCode.UPSTREAM_ERROR, message);
	}

	return parsed.data;
}

async function collectProjectFiles(directory: string, base = ''): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	try {
		const entries = await fs.readdir(directory, { withFileTypes: true });
		const results = await Promise.all(
			entries
				.filter((entry: { name: string }) => !HIDDEN_ENTRIES.has(entry.name))
				.map(async (entry: { name: string; isDirectory: () => boolean }) => {
					const relativePath = base ? `${base}/${entry.name}` : entry.name;
					const fullPath = `${directory}/${entry.name}`;
					if (entry.isDirectory()) {
						return collectProjectFiles(fullPath, relativePath);
					}
					const content = await fs.readFile(fullPath, 'utf8');
					return { [relativePath]: content };
				}),
		);
		for (const result of results) {
			Object.assign(files, result);
		}
	} catch (error) {
		if (base === '') {
			console.error('collectProjectFiles error:', error);
		}
	}
	return files;
}

async function readFileBinary(filePath: string): Promise<Uint8Array> {
	const buffer = await fs.readFile(filePath);
	return new Uint8Array(buffer);
}

function findWorkerEntryPoint(files: Record<string, string>): string | undefined {
	const candidates = [
		'worker/index.ts',
		'worker/index.js',
		'worker/index.mts',
		'worker/index.mjs',
		'src/index.ts',
		'src/index.js',
		'index.ts',
		'index.js',
	];
	return candidates.find((candidate) => candidate in files);
}

export function extractFrontendEntryPoint(html: string): string | undefined {
	const scriptRegex = /<script[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
	let match: RegExpExecArray | null;
	while ((match = scriptRegex.exec(html)) !== null) {
		const source = match[1];
		if (source.startsWith('http://') || source.startsWith('https://') || source.startsWith('__')) {
			continue;
		}
		return source.startsWith('/') ? source.slice(1) : source;
	}
	return undefined;
}

export function isSourceFile(filePath: string): boolean {
	return /\.(ts|tsx|jsx|mts|mjs)$/.test(filePath) || (filePath.startsWith('src/') && filePath.endsWith('.js'));
}

const CONFIG_FILES = new Set([
	'.initialized',
	'tsconfig.json',
	'tsconfig.app.json',
	'tsconfig.worker.json',
	'package.json',
	'wrangler.jsonc',
	'vite.config.ts',
	'vitest.config.ts',
	'worker-env.d.ts',
	'package-lock.json',
	'bun.lockb',
	'.gitignore',
	'.eslintrc.json',
	'.prettierrc',
	'biome.json',
	'README.md',
	'readme.md',
]);

export function isConfigFile(filePath: string): boolean {
	return CONFIG_FILES.has(filePath);
}

export function generateProductionHtml(html: string, originalEntry: string, bundledPath: string): string {
	const escaped = originalEntry.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
	const regex = new RegExp(String.raw`(<script[^>]*\bsrc=["'])(?:/?${escaped})(["'][^>]*>)`, 'gi');
	return html.replace(regex, `$1${bundledPath}$2`);
}

async function loadTsconfigRaw(projectRoot: string): Promise<string | undefined> {
	try {
		const content = await fs.readFile(`${projectRoot}/tsconfig.json`, 'utf8');
		const tsConfig: NonNullable<Parameters<typeof toEsbuildTsconfigRaw>[0]> = parseJsonc(content);

		if (!tsConfig.compilerOptions) {
			try {
				const appContent = await fs.readFile(`${projectRoot}/tsconfig.app.json`, 'utf8');
				const appTsConfig: NonNullable<Parameters<typeof toEsbuildTsconfigRaw>[0]> = parseJsonc(appContent);
				return toEsbuildTsconfigRaw(appTsConfig);
			} catch {
				return undefined;
			}
		}

		return toEsbuildTsconfigRaw(tsConfig);
	} catch {
		return undefined;
	}
}

async function hashContent(content: string): Promise<string> {
	const data = new TextEncoder().encode(content);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = [...new Uint8Array(hashBuffer)];
	return hashArray.map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function hashFileForManifest(content: Uint8Array, filePath: string): Promise<string> {
	const extension = filePath.split('.').pop() || '';
	const base64Content = uint8ArrayToBase64(content);
	const data = new TextEncoder().encode(base64Content + extension + filePath);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = [...new Uint8Array(hashBuffer)];
	return hashArray
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
		.slice(0, 32);
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCodePoint(byte);
	}
	return btoa(binary);
}

export async function readProjectBuildInputs(projectRoot: string): Promise<ProjectBuildInputs> {
	const projectName = await readProjectName(projectRoot);
	const assetSettings = await readAssetSettings(projectRoot);
	const bindingsConfig = await readBindingsConfig(projectRoot);
	const dependenciesRecord = await readDependencies(projectRoot);
	const registeredDependencies = new Map(Object.entries(dependenciesRecord));
	const tsconfigRaw = await loadTsconfigRaw(projectRoot);
	const allFiles = await collectProjectFiles(projectRoot);

	return { projectName, assetSettings, bindingsConfig, registeredDependencies, tsconfigRaw, allFiles };
}

export async function bundleWorker(projectRoot: string, inputs: ProjectBuildInputs, snapshotOnly = false): Promise<WorkerBundleResult> {
	const workerFiles = snapshotOnly ? {} : await collectProjectFiles(`${projectRoot}/worker`, 'worker');
	const workerBundleFiles: Record<string, string> = { ...workerFiles };
	for (const [filePath, content] of Object.entries(inputs.allFiles)) {
		if (!filePath.startsWith('src/') && !(filePath in workerBundleFiles)) {
			workerBundleFiles[filePath] = content;
		}
	}

	const workerEntry = findWorkerEntryPoint(workerBundleFiles);
	if (!workerEntry) {
		throw httpError(
			HttpErrorCode.VALIDATION_ERROR,
			'No worker entry point found. Expected worker/index.ts, worker/index.js, src/index.ts, or index.ts',
		);
	}

	const workerBundle = await withSpan('deploy.bundleWorker', () =>
		bundleWithCdn({
			files: workerBundleFiles,
			entryPoint: workerEntry,
			platform: 'neutral',
			minify: true,
			knownDependencies: inputs.registeredDependencies,
			tsconfigRaw: inputs.tsconfigRaw,
		}),
	);

	return { workerCode: workerBundle.code };
}

export async function bundleFrontend(projectRoot: string, inputs: ProjectBuildInputs): Promise<FrontendBundleResult> {
	const staticAssets = new Map<string, Uint8Array>();
	const hasIndexHtml = 'index.html' in inputs.allFiles;

	if (!hasIndexHtml) {
		return { staticAssetsEntries: [] };
	}

	const indexHtml = inputs.allFiles['index.html'];
	const frontendEntry = extractFrontendEntryPoint(indexHtml);

	if (frontendEntry && frontendEntry in inputs.allFiles) {
		const sourceFiles = await collectProjectFiles(`${projectRoot}/src`, 'src');
		const frontendBundleFiles: Record<string, string> = { ...sourceFiles };
		for (const [filePath, content] of Object.entries(inputs.allFiles)) {
			if (!(filePath in frontendBundleFiles) && !filePath.startsWith('worker/')) {
				frontendBundleFiles[filePath] = content;
			}
		}

		const frontendBundle = await withSpan('deploy.bundleFrontend', () =>
			bundleWithCdn({
				files: frontendBundleFiles,
				entryPoint: frontendEntry,
				platform: 'browser',
				minify: true,
				knownDependencies: inputs.registeredDependencies,
				tsconfigRaw: inputs.tsconfigRaw,
			}),
		);

		const frontendHash = await hashContent(frontendBundle.code);
		const bundleFilename = `assets/bundle-${frontendHash.slice(0, 8)}.js`;
		staticAssets.set(`/${bundleFilename}`, new TextEncoder().encode(frontendBundle.code));
		const productionHtml = generateProductionHtml(indexHtml, frontendEntry, `/${bundleFilename}`);
		staticAssets.set('/index.html', new TextEncoder().encode(productionHtml));
	} else {
		staticAssets.set('/index.html', new TextEncoder().encode(indexHtml));
	}

	for (const filePath of Object.keys(inputs.allFiles)) {
		const assetPath = `/${filePath}`;
		if (staticAssets.has(assetPath)) continue;
		if (filePath.startsWith('worker/')) continue;
		if (filePath === 'index.html') continue;
		if (isSourceFile(filePath)) continue;
		if (isConfigFile(filePath)) continue;
		staticAssets.set(assetPath, await readFileBinary(`${projectRoot}/${filePath}`));
	}

	return { staticAssetsEntries: [...staticAssets.entries()].map(([path, content]) => [path, [...content]]) };
}

export function entriesToStaticAssets(entries: Array<[string, number[]]>): Map<string, Uint8Array> {
	return new Map(entries.map(([path, content]) => [path, new Uint8Array(content)]));
}

export async function ensureR2Bucket(accountId: string, accessToken: string, bucketName: string): Promise<void> {
	const checkResponse = await fetch(`${CLOUDFLARE_API_BASE}/accounts/${accountId}/r2/buckets/${bucketName}`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});

	if (checkResponse.ok) {
		return;
	}

	const createResponse = await fetch(`${CLOUDFLARE_API_BASE}/accounts/${accountId}/r2/buckets`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${accessToken}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ name: bucketName }),
	});

	if (!createResponse.ok && createResponse.status !== 409) {
		const errorText = await createResponse.text();
		throw httpError(
			HttpErrorCode.UPSTREAM_ERROR,
			`Failed to create R2 bucket "${bucketName}": ${extractApiError(errorText, createResponse.status)}`,
		);
	}
}

export async function uploadStaticAssets(
	accountId: string,
	accessToken: string,
	workerName: string,
	assets: Map<string, Uint8Array>,
): Promise<string> {
	const manifest: Record<string, { hash: string; size: number }> = {};
	const hashToPath = new Map<string, string>();
	const hashToContent = new Map<string, Uint8Array>();

	for (const [filePath, content] of assets) {
		const hash = await hashFileForManifest(content, filePath);
		manifest[filePath] = { hash, size: content.byteLength };
		hashToPath.set(hash, filePath);
		hashToContent.set(hash, content);
	}

	const sessionResponse = await fetch(`${CLOUDFLARE_API_BASE}/accounts/${accountId}/workers/scripts/${workerName}/assets-upload-session`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${accessToken}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ manifest }),
	});

	if (!sessionResponse.ok) {
		const errorText = await sessionResponse.text();
		throw httpError(
			HttpErrorCode.UPSTREAM_ERROR,
			`Failed to create asset upload session: ${extractApiError(errorText, sessionResponse.status)}`,
		);
	}

	const sessionData = parseUpstreamResponse(
		assetUploadSessionResponseSchema,
		await sessionResponse.json(),
		'Asset upload session returned an invalid response',
	);
	const uploadJwt = sessionData.result?.jwt;
	const buckets = sessionData.result?.buckets;

	if (!uploadJwt) {
		throw httpError(HttpErrorCode.UPSTREAM_ERROR, 'Asset upload session did not return a JWT');
	}

	if (!buckets || buckets.length === 0) {
		return uploadJwt;
	}

	let completionJwt: string | undefined;

	for (const bucket of buckets) {
		const formData = new FormData();
		for (const hash of bucket) {
			const content = hashToContent.get(hash);
			const filePath = hashToPath.get(hash);
			if (content && filePath) {
				const mimeType = getContentType(filePath);
				formData.append(hash, new File([uint8ArrayToBase64(content)], hash, { type: mimeType }), hash);
			}
		}

		const uploadResponse = await fetch(`${CLOUDFLARE_API_BASE}/accounts/${accountId}/workers/assets/upload?base64=true`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${uploadJwt}`,
			},
			body: formData,
		});

		if (!uploadResponse.ok) {
			const errorText = await uploadResponse.text();
			throw httpError(HttpErrorCode.UPSTREAM_ERROR, `Failed to upload assets: ${extractApiError(errorText, uploadResponse.status)}`);
		}

		const uploadData = parseUpstreamResponse(
			assetUploadResponseSchema,
			await uploadResponse.json(),
			'Asset upload returned an invalid response',
		);
		if (uploadData.result?.jwt) {
			completionJwt = uploadData.result.jwt;
		}
	}

	if (!completionJwt) {
		throw httpError(HttpErrorCode.UPSTREAM_ERROR, 'Asset upload completed but no completion JWT was received');
	}

	return completionJwt;
}

/** A single module in a Workers module-worker upload. */
export interface WorkerScriptModule {
	/** Module name, matching the import specifier used inside the bundle. */
	name: string;
	contents: string;
}

/**
 * Map an emitted server module to its Workers multipart upload part (Content-Type
 * + body), chosen by extension.
 *
 * The Workers Script Upload API does not accept `application/json` as a module
 * Content-Type (it rejects with "unsupported Content-Type application/json").
 * We therefore handle `.json` exactly the way Vite / the Cloudflare Vite plugin
 * do: compile it to an ES module that default-exports the parsed value (Vite's
 * `json` plugin and esbuild's `json` loader emit precisely this). The module
 * keeps its `.json` name, so any `import x from "./x.json"` — or dynamic
 * `import("./x.json")`, which yields `{ default: value }` either way — still
 * resolves to the parsed object, identical to the JSON-module semantics the
 * preview LOADER isolate uses (`{ json }`). Manifests without a JS extension
 * (e.g. `BUILD_ID`) and emitted CSS are uploaded as text modules.
 */
export function toWorkerModulePart(name: string, contents: string): { contentType: string; body: string } {
	if (name.endsWith('.json')) {
		// JSON is a strict subset of JS expressions, so `export default <json>` is
		// valid; guard the (invalid-JSON) empty file to a defined module.
		const value = contents.trim() === '' ? 'null' : contents;
		return { contentType: 'application/javascript+module', body: `export default ${value};\n` };
	}
	if (name.endsWith('.js') || name.endsWith('.mjs')) {
		return { contentType: 'application/javascript+module', body: contents };
	}
	return { contentType: 'text/plain', body: contents };
}

export interface UploadWorkerModulesOptions {
	accountId: string;
	accessToken: string;
	workerName: string;
	/** Entry module name within {@link modules}. */
	mainModule: string;
	modules: WorkerScriptModule[];
	assetsCompletionJwt?: string;
	assetSettings?: AssetSettings;
	r2BucketName?: string;
}

/** Upload a (possibly multi-module) module worker with its metadata + bindings. */
export async function uploadWorkerModules(options: UploadWorkerModulesOptions): Promise<void> {
	const formData = new FormData();

	interface DeployMetadata {
		main_module: string;
		compatibility_date: string;
		compatibility_flags: string[];
		observability: { enabled: boolean };
		assets?: {
			jwt: string;
			config: {
				not_found_handling?: string;
				html_handling?: string;
				run_worker_first?: boolean | string[];
			};
		};
		bindings?: Array<{ type: string; name: string; bucket_name?: string }>;
	}

	const metadata: DeployMetadata = {
		main_module: options.mainModule,
		compatibility_date: WORKERS_COMPATIBILITY_DATE,
		compatibility_flags: ['nodejs_compat'],
		observability: { enabled: true },
	};

	if (options.assetsCompletionJwt) {
		metadata.assets = {
			jwt: options.assetsCompletionJwt,
			config: resolveAssetSettings(options.assetSettings),
		};
		metadata.bindings = [{ type: 'assets', name: 'ASSETS' }];
	}

	if (options.r2BucketName) {
		metadata.bindings ??= [];
		metadata.bindings.push({ type: 'r2_bucket', name: 'STORAGE', bucket_name: options.r2BucketName });
	}

	formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
	for (const module of options.modules) {
		const part = toWorkerModulePart(module.name, module.contents);
		formData.append(module.name, new Blob([part.body], { type: part.contentType }), module.name);
	}

	const uploadResponse = await fetch(`${CLOUDFLARE_API_BASE}/accounts/${options.accountId}/workers/scripts/${options.workerName}`, {
		method: 'PUT',
		headers: { Authorization: `Bearer ${options.accessToken}` },
		body: formData,
	});

	if (!uploadResponse.ok) {
		const errorText = await uploadResponse.text();
		throw httpError(HttpErrorCode.UPSTREAM_ERROR, `Failed to deploy worker: ${extractApiError(errorText, uploadResponse.status)}`);
	}
}

export async function uploadWorkerScript(
	accountId: string,
	accessToken: string,
	workerName: string,
	workerCode: string,
	assetsCompletionJwt: string | undefined,
	assetSettings?: AssetSettings,
	r2BucketName?: string,
): Promise<void> {
	return uploadWorkerModules({
		accountId,
		accessToken,
		workerName,
		mainModule: 'worker.mjs',
		modules: [{ name: 'worker.mjs', contents: workerCode }],
		assetsCompletionJwt,
		assetSettings,
		r2BucketName,
	});
}

export async function enableWorkersDevelopmentSubdomain(accountId: string, accessToken: string, workerName: string): Promise<void> {
	const response = await fetch(`${CLOUDFLARE_API_BASE}/accounts/${accountId}/workers/scripts/${workerName}/subdomain`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${accessToken}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ enabled: true }),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw httpError(HttpErrorCode.UPSTREAM_ERROR, `Failed to enable workers.dev subdomain: ${extractApiError(errorText, response.status)}`);
	}
}

export async function getWorkersDevelopmentUrl(accountId: string, accessToken: string, workerName: string): Promise<string | undefined> {
	try {
		const subdomainResponse = await fetch(`${CLOUDFLARE_API_BASE}/accounts/${accountId}/workers/subdomain`, {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		if (subdomainResponse.ok) {
			const data = parseUpstreamResponse(
				workersSubdomainResponseSchema,
				await subdomainResponse.json(),
				'Workers subdomain lookup returned an invalid response',
			);
			if (data.result?.subdomain) {
				return `https://${workerName}.${data.result.subdomain}.workers.dev`;
			}
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function extractApiError(responseBody: string, statusCode: number): string {
	try {
		const parsed: { errors?: Array<{ message: string }> } = JSON.parse(responseBody);
		if (parsed.errors && parsed.errors.length > 0) {
			return parsed.errors.map((error) => error.message).join('; ');
		}
	} catch {
		return `API returned status ${statusCode}`;
	}
	return `API returned status ${statusCode}`;
}

export { sanitizeR2BucketName, sanitizeWorkerName } from '@shared/deploy-helpers';
