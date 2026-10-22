import { stripIndent } from 'common-tags';

import { PROTECTED_SYSTEM_FILES, STORAGE_BINDING_NAME, WORKERS_COMPATIBILITY_DATE } from '@shared/constants';
import { parseJsonc } from '@shared/jsonc';
import { resolveAssetSettings } from '@shared/types';
import { fs } from '@worker/lib/project-fs';

import { isVinextProject } from '../services/vite-host/vinext-detection';

import type { AssetSettings, BindingsConfig } from '@shared/types';

/**
 * Detect whether the project on disk is a vinext app.
 *
 * vinext projects manage their own framework-shaped config, so the IDE must
 * generate vinext-appropriate `wrangler.jsonc`/`vite.config.ts`/`package.json`
 * for them rather than the Worker-SPA defaults (which would clobber the project).
 * Mirrors the runtime detector by combining the `package.json` manifest with the
 * presence of an `app/` or `pages/` directory.
 */
async function detectVinextProject(projectRoot: string): Promise<boolean> {
	let packageJsonRaw: string;
	try {
		packageJsonRaw = await fs.readFile(`${projectRoot}/package.json`, 'utf8');
	} catch {
		return false;
	}
	const files: Record<string, string> = { '/package.json': packageJsonRaw };
	for (const directory of ['app', 'pages']) {
		try {
			const entries = await fs.readdir(`${projectRoot}/${directory}`);
			if (entries.length > 0) {
				files[`/${directory}/.marker`] = '';
			}
		} catch {
			// Directory absent — ignore.
		}
	}
	return isVinextProject(files);
}

interface ProjectFileFlags {
	hasReact: boolean;
	hasTypeScript: boolean;
	hasTests: boolean;
}
function detectProjectFlags(dependencies: Record<string, string>, filePaths: string[]): ProjectFileFlags {
	return {
		hasReact: 'react' in dependencies,
		hasTypeScript: filePaths.some((f) => f.endsWith('.ts') || f.endsWith('.tsx')),
		hasTests: filePaths.some((f) => f.includes('.test.') || f.includes('.spec.') || f.startsWith('test/')),
	};
}
export async function readDependencies(projectRoot: string): Promise<Record<string, string>> {
	try {
		const raw = await fs.readFile(`${projectRoot}/package.json`, 'utf8');
		const parsed: { dependencies?: Record<string, string> } = JSON.parse(raw);
		return parsed.dependencies ?? {};
	} catch {
		return {};
	}
}

/**
 * Write updated `dependencies` into `package.json` on disk.
 * Does NOT regenerate other protected files — call `regenerateProtectedFiles` afterward.
 */
export async function writeDependencies(projectRoot: string, dependencies: Record<string, string>): Promise<void> {
	// Intentionally a no-op on package.json structure; regenerateProtectedFiles
	// will rewrite the full file. We just need to persist the dependencies value
	// so the subsequent regenerateProtectedFiles call reads them back.
	const packageJsonPath = `${projectRoot}/package.json`;
	let existing: Record<string, unknown> = {};
	try {
		const raw = await fs.readFile(packageJsonPath, 'utf8');
		existing = JSON.parse(raw);
	} catch {
		// No existing package.json — will create one
	}
	existing.dependencies = dependencies;
	await fs.writeFile(packageJsonPath, JSON.stringify(existing, undefined, 2));
}
export async function readProjectName(projectRoot: string): Promise<string> {
	try {
		const raw = await fs.readFile(`${projectRoot}/package.json`, 'utf8');
		const parsed: { name?: string } = JSON.parse(raw);
		return parsed.name || 'my-worker-app';
	} catch {
		return 'my-worker-app';
	}
}

/**
 * Write the project name into `package.json` on disk.
 * Creates the file if it doesn't exist.
 */
export async function writeProjectName(projectRoot: string, name: string): Promise<void> {
	const packageJsonPath = `${projectRoot}/package.json`;
	let existing: Record<string, unknown> = {};
	try {
		const raw = await fs.readFile(packageJsonPath, 'utf8');
		existing = JSON.parse(raw);
	} catch {
		// No existing package.json — will create one
	}
	existing.name = name;
	await fs.writeFile(packageJsonPath, JSON.stringify(existing, undefined, 2));
}
export async function readAssetSettings(projectRoot: string): Promise<AssetSettings> {
	try {
		const raw = await fs.readFile(`${projectRoot}/wrangler.jsonc`, 'utf8');
		const parsed: { assets?: AssetSettings } = parseJsonc(raw);
		return parsed.assets ?? {};
	} catch {
		return {};
	}
}

/**
 * Read bindings configuration from `wrangler.jsonc` on disk.
 * Detects bindings from standard wrangler fields (e.g. `r2_buckets`).
 */
export async function readBindingsConfig(projectRoot: string): Promise<BindingsConfig> {
	try {
		const raw = await fs.readFile(`${projectRoot}/wrangler.jsonc`, 'utf8');
		const parsed: { r2_buckets?: Array<{ binding?: string }> } = parseJsonc(raw);

		const hasStorageBinding = Array.isArray(parsed.r2_buckets) && parsed.r2_buckets.some((b) => b.binding === STORAGE_BINDING_NAME);
		return hasStorageBinding ? { storage: true } : {};
	} catch {
		return {};
	}
}

/**
 * Write asset settings into `wrangler.jsonc` on disk.
 * Preserves bindings config and regenerates the file.
 */
export async function writeAssetSettings(projectRoot: string, assetSettings: AssetSettings): Promise<void> {
	const projectName = await readProjectName(projectRoot);
	const bindingsConfig = await readBindingsConfig(projectRoot);

	// vinext manages its own assets config; only bindings carry over.
	if (await detectVinextProject(projectRoot)) {
		await fs.writeFile(
			`${projectRoot}/wrangler.jsonc`,
			JSON.stringify(buildVinextWranglerConfig(projectName, bindingsConfig), undefined, '\t'),
		);
		return;
	}

	const assetsConfig = resolveAssetSettings(assetSettings);
	await fs.writeFile(
		`${projectRoot}/wrangler.jsonc`,
		JSON.stringify(buildWranglerConfig(projectName, assetsConfig, bindingsConfig), undefined, '\t'),
	);
}

/**
 * Write bindings configuration into `wrangler.jsonc` on disk.
 * Writes standard wrangler fields (e.g. `r2_buckets`) — no IDE-specific keys.
 * Preserves asset settings and regenerates the file.
 */
export async function writeBindingsConfig(projectRoot: string, bindingsConfig: BindingsConfig): Promise<void> {
	const projectName = await readProjectName(projectRoot);

	if (await detectVinextProject(projectRoot)) {
		await fs.writeFile(
			`${projectRoot}/wrangler.jsonc`,
			JSON.stringify(buildVinextWranglerConfig(projectName, bindingsConfig), undefined, '\t'),
		);
		return;
	}

	const assetSettings = await readAssetSettings(projectRoot);
	const assetsConfig = resolveAssetSettings(assetSettings);
	await fs.writeFile(
		`${projectRoot}/wrangler.jsonc`,
		JSON.stringify(buildWranglerConfig(projectName, assetsConfig, bindingsConfig), undefined, '\t'),
	);
}

/**
 * Build the full wrangler.jsonc config object.
 * Uses standard wrangler fields only — no IDE-specific keys.
 */
function buildWranglerConfig(
	projectName: string,
	assetsConfig: ReturnType<typeof resolveAssetSettings>,
	bindingsConfig: BindingsConfig,
): Record<string, unknown> {
	const config: Record<string, unknown> = {
		$schema: 'node_modules/wrangler/config-schema.json',
		name: projectName,
		main: 'worker/index.ts',
		compatibility_date: WORKERS_COMPATIBILITY_DATE,
		assets: assetsConfig,
		observability: { enabled: true },
	};

	if (bindingsConfig.storage) {
		config.r2_buckets = [{ binding: STORAGE_BINDING_NAME, bucket_name: 'my-bucket' }];
	}

	return config;
}

/**
 * Build the vinext-shaped `wrangler.jsonc` config object.
 *
 * vinext deploys via `@cloudflare/vite-plugin` + `vinext/server/app-router-entry`,
 * so the config differs from the Worker-SPA shape: no hand-written `worker/index.ts`
 * entry, and the client build directory is served as assets. The R2 storage binding
 * still uses the curated `STORAGE` name so it round-trips through `readBindingsConfig`
 * and is attached on deploy.
 */
function buildVinextWranglerConfig(projectName: string, bindingsConfig: BindingsConfig): Record<string, unknown> {
	const config: Record<string, unknown> = {
		$schema: 'node_modules/wrangler/config-schema.json',
		name: projectName,
		compatibility_date: WORKERS_COMPATIBILITY_DATE,
		compatibility_flags: ['nodejs_compat'],
		main: 'vinext/server/app-router-entry',
		assets: {
			directory: 'dist/client',
			not_found_handling: 'none',
			binding: 'ASSETS',
		},
	};

	if (bindingsConfig.storage) {
		config.r2_buckets = [{ binding: STORAGE_BINDING_NAME, bucket_name: 'my-bucket' }];
	}

	return config;
}

/**
 * Regenerate a vinext project's `package.json`, preserving its framework-specific
 * `scripts`/`devDependencies`/`type` while syncing the IDE-owned `name` and
 * `dependencies` fields. (The Worker-SPA generator would otherwise replace the
 * vinext scripts and devDependencies, breaking the project.)
 */
async function generateVinextPackageJson(projectRoot: string, projectName: string, dependencies: Record<string, string>): Promise<string> {
	let existing: Record<string, unknown> = {};
	try {
		existing = JSON.parse(await fs.readFile(`${projectRoot}/package.json`, 'utf8'));
	} catch {
		// No existing package.json — start from an empty object.
	}
	existing.name = projectName;
	existing.dependencies = dependencies;
	return JSON.stringify(existing, undefined, 2);
}
function generatePackageJson(projectName: string, filePaths: string[], dependencies: Record<string, string>): string {
	const { hasReact, hasTypeScript, hasTests } = detectProjectFlags(dependencies, filePaths);

	const devDependencies: Record<string, string> = {
		'@cloudflare/vite-plugin': '^1.0.0',
		vite: '^6.0.0',
		wrangler: '^4.83.0',
	};
	if (hasReact) {
		devDependencies['@types/react'] = '^19.0.0';
		devDependencies['@types/react-dom'] = '^19.0.0';
		devDependencies['@vitejs/plugin-react'] = '^4.0.0';
	}
	if (hasTypeScript) {
		devDependencies.typescript = '^5.0.0';
	}
	if (hasTests) {
		devDependencies.vitest = '^3.0.0';
	}

	const scripts: Record<string, string> = {
		dev: 'vite dev',
		build: 'vite build',
		deploy: 'vite build && wrangler deploy',
	};
	if (hasTests) {
		scripts.test = 'vitest run';
	}

	const packageJson: Record<string, unknown> = {
		name: projectName,
		type: 'module',
		scripts,
		dependencies,
		devDependencies,
	};

	return JSON.stringify(packageJson, undefined, 2);
}
function generateWranglerJsonc(projectName: string, assetSettings: AssetSettings, bindingsConfig: BindingsConfig): string {
	const assetsConfig = resolveAssetSettings(assetSettings);

	return JSON.stringify(buildWranglerConfig(projectName, assetsConfig, bindingsConfig), undefined, '\t');
}

function joinGeneratedBlocks(...blocks: Array<string | undefined>): string {
	return `${blocks.filter(Boolean).join('\n\n')}\n`;
}

/**
 * Generate the contents of `worker-env.d.ts` based on enabled bindings.
 * When no bindings are enabled, generates a minimal Env interface with no extra properties.
 */
function generateWorkerEnvironmentDeclaration(bindingsConfig: BindingsConfig): string {
	const storageDeclarations = bindingsConfig.storage
		? stripIndent`
			interface StorageChecksums {
				readonly md5?: ArrayBuffer;
				readonly sha1?: ArrayBuffer;
				readonly sha256?: ArrayBuffer;
				readonly sha384?: ArrayBuffer;
				readonly sha512?: ArrayBuffer;
				toJSON(): { md5?: string; sha1?: string; sha256?: string; sha384?: string; sha512?: string };
			}

			interface StorageHttpMetadata {
				contentType?: string;
				contentLanguage?: string;
				contentDisposition?: string;
				contentEncoding?: string;
				cacheControl?: string;
				cacheExpiry?: Date;
			}

			type StorageRange = { offset: number; length?: number } | { offset?: number; length: number } | { suffix: number };

			interface StorageConditional {
				etagMatches?: string;
				etagDoesNotMatch?: string;
				uploadedBefore?: Date;
				uploadedAfter?: Date;
				secondsGranularity?: boolean;
			}

			interface StorageGetOptions {
				onlyIf?: StorageConditional | Headers;
				range?: StorageRange | Headers;
			}

			interface StoragePutOptions {
				onlyIf?: StorageConditional | Headers;
				httpMetadata?: StorageHttpMetadata | Headers;
				customMetadata?: Record<string, string>;
				md5?: ArrayBuffer | ArrayBufferView | string;
				sha1?: ArrayBuffer | ArrayBufferView | string;
				sha256?: ArrayBuffer | ArrayBufferView | string;
				sha384?: ArrayBuffer | ArrayBufferView | string;
				sha512?: ArrayBuffer | ArrayBufferView | string;
				storageClass?: string;
			}

			interface StorageListOptions {
				limit?: number;
				prefix?: string;
				cursor?: string;
				delimiter?: string;
				startAfter?: string;
				include?: ("httpMetadata" | "customMetadata")[];
			}

			interface StorageObject {
				readonly key: string;
				readonly version: string;
				readonly size: number;
				readonly etag: string;
				readonly httpEtag: string;
				readonly checksums: StorageChecksums;
				readonly uploaded: Date;
				readonly httpMetadata?: StorageHttpMetadata;
				readonly customMetadata?: Record<string, string>;
				readonly range?: StorageRange;
				readonly storageClass: string;
				writeHttpMetadata(headers: Headers): void;
			}

			interface StorageObjectBody extends StorageObject {
				readonly body: ReadableStream;
				readonly bodyUsed: boolean;
				arrayBuffer(): Promise<ArrayBuffer>;
				bytes(): Promise<Uint8Array>;
				text(): Promise<string>;
				json<T = unknown>(): Promise<T>;
				blob(): Promise<Blob>;
			}

			interface StorageListResult {
				readonly objects: StorageObject[];
				readonly truncated: boolean;
				readonly cursor?: string;
				readonly delimitedPrefixes: string[];
			}

			interface StorageBinding {
				head(key: string): Promise<StorageObject | null>;
				get(key: string, options?: StorageGetOptions): Promise<StorageObjectBody | StorageObject | null>;
				put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob, options?: StoragePutOptions): Promise<StorageObject | null>;
				delete(keys: string | string[]): Promise<void>;
				list(options?: StorageListOptions): Promise<StorageListResult>;
			}
		`
		: undefined;

	const environmentProperties = [bindingsConfig.storage ? `${STORAGE_BINDING_NAME}: StorageBinding;` : undefined].filter(Boolean);

	const environmentDeclaration =
		environmentProperties.length === 0
			? stripIndent`
				interface Env {}
			`
			: stripIndent`
				interface Env {
					${environmentProperties.join('\n\t')}
				}
			`;

	return joinGeneratedBlocks(storageDeclarations, environmentDeclaration);
}
function generateViteConfig(dependencies: Record<string, string>): string {
	const hasReact = 'react' in dependencies;

	if (hasReact) {
		return `\
import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
\tplugins: [react(), cloudflare()],
});
`;
	}

	return `\
import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

export default defineConfig({
\tplugins: [cloudflare()],
});
`;
}
function generateVitestConfig(): string {
	return `\
import { defineConfig } from 'vitest/config';

export default defineConfig({
\ttest: {
\t\tglobals: true,
\t\tinclude: ['test/**/*.test.{js,ts,jsx,tsx}', 'src/**/*.test.{js,ts,jsx,tsx}'],
\t},
});
`;
}

/** Regenerate managed files. Live updates must hold the project mutation queue. */
export async function regenerateProtectedFiles(projectRoot: string): Promise<void> {
	await doRegenerate(projectRoot);
}

async function doRegenerate(projectRoot: string): Promise<void> {
	const filePaths = await listFilePaths(projectRoot);
	const projectName = await readProjectName(projectRoot);
	const dependencies = await readDependencies(projectRoot);
	const assetSettings = await readAssetSettings(projectRoot);
	const bindingsConfig = await readBindingsConfig(projectRoot);

	// vinext projects use framework-shaped config. The IDE only owns package.json
	// (name/deps) and wrangler.jsonc for vinext; vinext auto-configures Vite at
	// build time, so a project-level vite.config.ts is intentionally NOT generated
	// (shipping one couples us to the framework's exact expected config and breaks
	// the preview build). vitest.config.ts/worker-env.d.ts are not part of vinext.
	if (await detectVinextProject(projectRoot)) {
		await fs.writeFile(`${projectRoot}/package.json`, await generateVinextPackageJson(projectRoot, projectName, dependencies));
		await fs.writeFile(
			`${projectRoot}/wrangler.jsonc`,
			JSON.stringify(buildVinextWranglerConfig(projectName, bindingsConfig), undefined, '\t'),
		);
		return;
	}

	await fs.writeFile(`${projectRoot}/package.json`, generatePackageJson(projectName, filePaths, dependencies));
	await fs.writeFile(`${projectRoot}/wrangler.jsonc`, generateWranglerJsonc(projectName, assetSettings, bindingsConfig));
	await fs.writeFile(`${projectRoot}/vite.config.ts`, generateViteConfig(dependencies));
	await fs.writeFile(`${projectRoot}/vitest.config.ts`, generateVitestConfig());
	await fs.writeFile(`${projectRoot}/worker-env.d.ts`, generateWorkerEnvironmentDeclaration(bindingsConfig));
}

/**
 * Collect relative file paths (no leading slash) for project characteristic detection.
 * Skips protected system files so they don't influence their own regeneration.
 */
async function listFilePaths(directory: string, base = ''): Promise<string[]> {
	const paths: string[] = [];
	try {
		const entries = await fs.readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name.startsWith('.')) continue;
			const relativePath = base ? `${base}/${entry.name}` : entry.name;
			// Skip protected system files so they don't self-reinforce feature detection
			if (!entry.isDirectory() && PROTECTED_SYSTEM_FILES.has(`/${relativePath}`)) continue;
			if (entry.isDirectory()) {
				paths.push(...(await listFilePaths(`${directory}/${entry.name}`, relativePath)));
			} else {
				paths.push(relativePath);
			}
		}
	} catch {
		// Ignore errors (empty project, etc.)
	}
	return paths;
}
