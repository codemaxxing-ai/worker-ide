import { parseJsonc } from '@shared/jsonc';
import {
	buildPreviewExternalModuleRequest,
	buildPreviewRequest,
	isPreviewModuleWrappedPath,
	isPreviewStylePath,
	isPreviewUrlModulePath,
	normalizePreviewPath,
	resolvePreviewPath,
	toPreviewExternalModuleId,
	toPreviewImportRequest,
	toPreviewModuleId,
} from '@shared/preview-path';

import { transformCode } from './bundler-client';

export interface FileSystem {
	readFile(path: string): Promise<string | Uint8Array>;
	access(path: string): Promise<void>;
}

export interface TransformOptions {
	fs: FileSystem;
	projectRoot: string;
	projectId: string;
	knownDependencies?: Map<string, string>;
	requestTimestamp?: string;
}

interface ResolvedImport {
	original: string;
	resolved: string;
	importedModuleId?: string;
}

interface ParsedImportReference {
	match: string;
	specifier: string;
	start: number;
	end: number;
}

interface BarePackageSpecifier {
	packageName: string;
	subpath: string | undefined;
}

interface TsConfigCompilerOptions {
	baseUrl?: string;
	paths?: Record<string, string[]>;
	target?: string;
	jsx?: 'preserve' | 'react' | 'react-jsx' | 'react-jsxdev' | 'react-native';
	jsxFactory?: string;
	jsxFragmentFactory?: string;
	jsxImportSource?: string;
	experimentalDecorators?: boolean;
	useDefineForClassFields?: boolean;
	verbatimModuleSyntax?: boolean;
	alwaysStrict?: boolean;
}

interface TsConfig {
	compilerOptions?: TsConfigCompilerOptions;
}
export function toEsbuildTsconfigRaw(tsConfig: TsConfig | undefined): string | undefined {
	if (!tsConfig?.compilerOptions) return undefined;

	const options = tsConfig.compilerOptions;
	const esbuildCompilerOptions: Record<string, unknown> = {};

	if (options.jsx) {
		esbuildCompilerOptions.jsx = options.jsx;
	}
	if (options.jsxFactory) {
		esbuildCompilerOptions.jsxFactory = options.jsxFactory;
	}
	if (options.jsxFragmentFactory) {
		esbuildCompilerOptions.jsxFragmentFactory = options.jsxFragmentFactory;
	}
	if (options.jsxImportSource) {
		esbuildCompilerOptions.jsxImportSource = options.jsxImportSource;
	}
	if (options.experimentalDecorators !== undefined) {
		esbuildCompilerOptions.experimentalDecorators = options.experimentalDecorators;
	}
	if (options.useDefineForClassFields !== undefined) {
		esbuildCompilerOptions.useDefineForClassFields = options.useDefineForClassFields;
	}
	if (options.verbatimModuleSyntax !== undefined) {
		esbuildCompilerOptions.verbatimModuleSyntax = options.verbatimModuleSyntax;
	}
	if (options.alwaysStrict !== undefined) {
		esbuildCompilerOptions.alwaysStrict = options.alwaysStrict;
	}

	if (Object.keys(esbuildCompilerOptions).length === 0) {
		return undefined;
	}

	return JSON.stringify({ compilerOptions: esbuildCompilerOptions });
}

const RESOLVABLE_EXTENSIONS = [
	'.ts',
	'.tsx',
	'.js',
	'.jsx',
	'.mts',
	'.mjs',
	'.css',
	'.json',
	'.svg',
	'.png',
	'.jpg',
	'.jpeg',
	'.gif',
	'.webp',
];

async function probeExtensions(fs: FileSystem, basePath: string, extensions: string[]): Promise<string | undefined> {
	const results = await Promise.allSettled(extensions.map((extension) => fs.access(`${basePath}${extension}`).then(() => extension)));
	for (const result of results) {
		if (result.status === 'fulfilled') return result.value;
	}
	return undefined;
}

async function loadTsConfig(fs: FileSystem, projectRoot: string): Promise<TsConfig | undefined> {
	try {
		const content = await fs.readFile(`${projectRoot}/tsconfig.json`);
		const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
		const config: TsConfig = parseJsonc(text);

		if (!config.compilerOptions) {
			return await loadTsConfigFile(fs, `${projectRoot}/tsconfig.app.json`);
		}

		return config;
	} catch {
		return undefined;
	}
}

async function loadTsConfigFile(fs: FileSystem, filePath: string): Promise<TsConfig | undefined> {
	try {
		const content = await fs.readFile(filePath);
		const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
		return parseJsonc(text);
	} catch {
		return undefined;
	}
}

function resolvePathAlias(specifier: string, tsConfig: TsConfig | undefined): string | undefined {
	if (!tsConfig?.compilerOptions?.paths) return undefined;

	const paths = tsConfig.compilerOptions.paths;
	const baseUrl = tsConfig.compilerOptions.baseUrl || '.';

	for (const [pattern, targets] of Object.entries(paths)) {
		if (pattern.endsWith('/*')) {
			const prefix = pattern.slice(0, -2);
			if (specifier.startsWith(prefix + '/')) {
				const rest = specifier.slice(prefix.length + 1);
				for (const target of targets) {
					if (target.endsWith('/*')) {
						const targetBase = target.slice(0, -2);
						return `/${baseUrl}/${targetBase}/${rest}`.replaceAll(/\/+/g, '/');
					}
				}
			}
		} else if (specifier === pattern) {
			for (const target of targets) {
				return `/${baseUrl}/${target}`.replaceAll(/\/+/g, '/');
			}
		}
	}

	return undefined;
}

async function resolveProjectPath(fs: FileSystem, projectRoot: string, targetPath: string): Promise<string> {
	const normalizedTargetPath = normalizePreviewPath(targetPath);
	const extension = normalizedTargetPath.match(/\.[^.]+$/)?.[0]?.toLowerCase() ?? '';
	if (extension.length > 0) {
		return normalizedTargetPath;
	}

	const directExtension = await probeExtensions(fs, `${projectRoot}${normalizedTargetPath}`, RESOLVABLE_EXTENSIONS);
	if (directExtension) {
		return `${normalizedTargetPath}${directExtension}`;
	}

	const indexExtension = await probeExtensions(fs, `${projectRoot}${normalizedTargetPath}/index`, RESOLVABLE_EXTENSIONS);
	if (indexExtension) {
		return `${normalizedTargetPath}/index${indexExtension}`;
	}

	return normalizedTargetPath;
}

function createLocalImportResolution(original: string, resolvedPath: string, requestTimestamp: string | undefined): ResolvedImport {
	const normalizedPath = normalizePreviewPath(resolvedPath);
	return {
		original,
		resolved: toPreviewImportRequest(normalizedPath, requestTimestamp),
		importedModuleId: toPreviewModuleId(normalizedPath),
	};
}

function createExternalImportResolution(
	original: string,
	specifierOrUrl: string,
	_requestTimestamp: string | undefined,
	baseUrl?: string,
): ResolvedImport {
	return {
		original,
		resolved: buildPreviewExternalModuleRequest(specifierOrUrl, { baseUrl }),
		importedModuleId: toPreviewExternalModuleId(specifierOrUrl, baseUrl),
	};
}

function parseBarePackageSpecifier(specifier: string): BarePackageSpecifier {
	const pathSegments = specifier.split('/');
	if (specifier.startsWith('@')) {
		const packageName = [pathSegments[0], pathSegments[1]].filter(Boolean).join('/');
		const subpath = pathSegments.slice(2).join('/');
		return {
			packageName,
			subpath: subpath.length > 0 ? subpath : undefined,
		};
	}

	const packageName = pathSegments[0] ?? specifier;
	const subpath = pathSegments.slice(1).join('/');
	return {
		packageName,
		subpath: subpath.length > 0 ? subpath : undefined,
	};
}

function resolveRegisteredDependencySpecifier(specifier: string, knownDependencies: Map<string, string>): string {
	const { packageName, subpath } = parseBarePackageSpecifier(specifier);
	const version = knownDependencies.get(packageName);
	if (version === undefined) {
		throw new Error(`Unregistered dependency "${packageName}". Add it to project dependencies using the Dependencies panel.`);
	}

	if (version === '*' || version.length === 0) {
		return specifier;
	}

	return subpath === undefined ? `${packageName}@${version}` : `${packageName}@${version}/${subpath}`;
}

function collectImportReferences(code: string): ParsedImportReference[] {
	const staticImportRegex = /\bimport\s*(?:[^"'()]+?\s*from\s*)?['"]([^'"]+)['"]/g;
	const staticExportRegex = /\bexport\s+[^"'()]+?\s*from\s*['"]([^'"]+)['"]/g;
	const dynamicImportRegex = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
	const imports: ParsedImportReference[] = [];

	let match: RegExpExecArray | null;
	while ((match = staticImportRegex.exec(code)) !== null) {
		imports.push({ match: match[0], specifier: match[1], start: match.index, end: match.index + match[0].length });
	}

	while ((match = staticExportRegex.exec(code)) !== null) {
		imports.push({ match: match[0], specifier: match[1], start: match.index, end: match.index + match[0].length });
	}

	while ((match = dynamicImportRegex.exec(code)) !== null) {
		imports.push({ match: match[0], specifier: match[1], start: match.index, end: match.index + match[0].length });
	}

	return imports;
}

async function resolveImport(
	specifier: string,
	importer: string,
	fs: FileSystem,
	projectRoot: string,
	tsConfig: TsConfig | undefined,
	knownDependencies: Map<string, string> | undefined,
	requestTimestamp: string | undefined,
): Promise<ResolvedImport> {
	if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier)) {
		return createExternalImportResolution(specifier, specifier, requestTimestamp);
	}

	// Check tsconfig paths first for non-relative imports
	if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
		const aliasResolved = resolvePathAlias(specifier, tsConfig);
		if (aliasResolved) {
			const resolvedPath = await resolveProjectPath(fs, projectRoot, aliasResolved);
			return createLocalImportResolution(specifier, resolvedPath, requestTimestamp);
		}

		const resolvedSpecifier = knownDependencies ? resolveRegisteredDependencySpecifier(specifier, knownDependencies) : specifier;
		return createExternalImportResolution(specifier, resolvedSpecifier, requestTimestamp);
	}

	// Relative imports
	const targetPath = resolvePreviewPath(specifier, importer);
	const resolvedPath = await resolveProjectPath(fs, projectRoot, targetPath);
	return createLocalImportResolution(specifier, resolvedPath, requestTimestamp);
}

async function rewriteImports(
	code: string,
	filePath: string,
	fs: FileSystem,
	projectRoot: string,
	tsConfig: TsConfig | undefined,
	knownDependencies: Map<string, string> | undefined,
	requestTimestamp: string | undefined,
): Promise<{ code: string; importedModuleIds: string[] }> {
	const imports = collectImportReferences(code);

	const resolved = await Promise.all(
		imports.map(async (imp) => ({
			...imp,
			resolution: await resolveImport(imp.specifier, filePath, fs, projectRoot, tsConfig, knownDependencies, requestTimestamp),
		})),
	);

	let result = code;
	const importedModuleIds: string[] = [];
	for (const imp of resolved.toSorted((a, b) => b.start - a.start)) {
		const newStatement = imp.match.replace(imp.specifier, imp.resolution.resolved);
		result = result.slice(0, imp.start) + newStatement + result.slice(imp.end);
		if (imp.resolution.importedModuleId !== undefined) {
			importedModuleIds.push(imp.resolution.importedModuleId);
		}
	}

	return { code: result, importedModuleIds: [...new Set(importedModuleIds)] };
}

export function rewriteExternalModuleImports(code: string, externalModuleUrl: string, requestTimestamp?: string): string {
	const imports = collectImportReferences(code);
	let result = code;
	void requestTimestamp;

	for (const importReference of imports.toSorted((a, b) => b.start - a.start)) {
		const { specifier } = importReference;
		if (specifier.startsWith('data:') || specifier.startsWith('blob:') || specifier.startsWith('node:')) {
			continue;
		}

		const resolvedSpecifier = buildPreviewExternalModuleRequest(specifier, {
			baseUrl: externalModuleUrl,
		});
		const rewrittenStatement = importReference.match.replace(specifier, resolvedSpecifier);
		result = result.slice(0, importReference.start) + rewrittenStatement + result.slice(importReference.end);
	}

	return result;
}

const tsConfigCache = new Map<string, { config: TsConfig | undefined; expiry: number }>();
const TSCONFIG_TTL_MS = 5000;
const MAX_TSCONFIG_CACHE = 100;
function tsConfigCacheKey(projectId: string, projectRoot: string): string {
	return JSON.stringify([projectId, projectRoot]);
}

export function invalidateTsConfigCache(projectId: string, projectRoot: string): void {
	tsConfigCache.delete(tsConfigCacheKey(projectId, projectRoot));
}

async function getTsConfig(fs: FileSystem, projectRoot: string, projectId: string): Promise<TsConfig | undefined> {
	const key = tsConfigCacheKey(projectId, projectRoot);
	const cached = tsConfigCache.get(key);
	if (cached && Date.now() < cached.expiry) {
		return cached.config;
	}
	const config = await loadTsConfig(fs, projectRoot);
	tsConfigCache.set(key, { config, expiry: Date.now() + TSCONFIG_TTL_MS });
	while (tsConfigCache.size > MAX_TSCONFIG_CACHE) {
		const first = tsConfigCache.keys().next().value;
		if (first === undefined) {
			break;
		} else {
			tsConfigCache.delete(first);
		}
	}
	return config;
}

function getContentType(extension: string): string {
	const types: Record<string, string> = {
		'.html': 'text/html',
		'.js': 'application/javascript',
		'.mjs': 'application/javascript',
		'.css': 'text/css',
		'.json': 'application/json',
		'.svg': 'image/svg+xml',
		'.png': 'image/png',
		'.jpg': 'image/jpeg',
		'.jpeg': 'image/jpeg',
		'.gif': 'image/gif',
		'.webp': 'image/webp',
	};
	return types[extension] || 'text/plain';
}

const COMPONENT_DECLARATION_REGEX =
	/(?:^|[\n;])\s*(?:export\s+(?:default\s+)?)?(?:function\s+([A-Z][A-Za-z0-9_$]*)\s*\(|(?:const|let|var)\s+([A-Z][A-Za-z0-9_$]*)\s*=)/g;

function detectComponentNames(code: string): string[] {
	const names = new Set<string>();
	let match: RegExpExecArray | null;
	COMPONENT_DECLARATION_REGEX.lastIndex = 0;
	while ((match = COMPONENT_DECLARATION_REGEX.exec(code)) !== null) {
		const name = match[1] || match[2];
		if (name) {
			names.add(name);
		}
	}
	return [...names];
}

const NAMED_DECLARATION_EXPORT_REGEX = /\bexport\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
const DEFAULT_IDENTIFIER_EXPORT_REGEX = /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;?/g;
const EXPORT_LIST_REGEX = /\bexport\s*\{([^}]*)\}/g;
const WILDCARD_REEXPORT_REGEX = /\bexport\s+\*(?:\s+as\s+[A-Za-z_$][\w$]*)?\s+from\b/;

function isComponentName(name: string): boolean {
	return /^[A-Z]/.test(name);
}

/**
 * Determine whether a module is a safe React Fast Refresh boundary.
 *
 * Mirrors @vitejs/plugin-react: a module may self-accept only when *every*
 * export is a React component (PascalCase). Modules that also export
 * non-component values must let the update propagate to their importers so
 * those non-component exports are not left stale.
 */
function hasNonComponentExport(code: string): boolean {
	if (WILDCARD_REEXPORT_REGEX.test(code)) {
		return true;
	}

	let match: RegExpExecArray | null;

	NAMED_DECLARATION_EXPORT_REGEX.lastIndex = 0;
	while ((match = NAMED_DECLARATION_EXPORT_REGEX.exec(code)) !== null) {
		if (!isComponentName(match[1])) {
			return true;
		}
	}

	DEFAULT_IDENTIFIER_EXPORT_REGEX.lastIndex = 0;
	while ((match = DEFAULT_IDENTIFIER_EXPORT_REGEX.exec(code)) !== null) {
		if (!isComponentName(match[1])) {
			return true;
		}
	}

	EXPORT_LIST_REGEX.lastIndex = 0;
	while ((match = EXPORT_LIST_REGEX.exec(code)) !== null) {
		const specifiers = match[1].split(',');
		for (const specifier of specifiers) {
			const trimmed = specifier.trim();
			if (trimmed.length === 0 || trimmed.startsWith('type ')) {
				continue;
			}
			const parts = trimmed.split(/\s+as\s+/);
			const exportedName = (parts[1] ?? parts[0]).trim();
			if (exportedName === 'default' || exportedName.length === 0) {
				continue;
			}
			if (!isComponentName(exportedName)) {
				return true;
			}
		}
	}

	return false;
}

function wrapModuleWithRefreshRegistrations(code: string, moduleId: string): { code: string; isBoundary: boolean } {
	const componentNames = detectComponentNames(code);
	if (componentNames.length === 0) {
		return { code, isBoundary: false };
	}

	const isBoundary = !hasNonComponentExport(code);

	const fileId = JSON.stringify(moduleId);
	const registrations = componentNames.map((name) => `  $RefreshReg$(${name}, ${JSON.stringify(name)});`).join('\n');

	return {
		code: [
			`var __prevRefreshReg = window.$RefreshReg$;`,
			`var __prevRefreshSig = window.$RefreshSig$;`,
			`window.$RefreshReg$ = function(type, id) {`,
			`  window.__RefreshRuntime && window.__RefreshRuntime.register(type, ${fileId} + " " + id);`,
			`};`,
			`window.$RefreshSig$ = window.__RefreshRuntime ? window.__RefreshRuntime.createSignatureFunctionForTransform() : function() { return function(type) { return type; }; };`,
			code,
			`if (window.__RefreshRuntime) {`,
			registrations,
			`}`,
			`window.$RefreshReg$ = __prevRefreshReg;`,
			`window.$RefreshSig$ = __prevRefreshSig;`,
		].join('\n'),
		isBoundary,
	};
}

function replaceImportMetaHot(code: string): string {
	return code.replaceAll(/\bimport\.meta\.hot\b/g, '__preview_hot__');
}

function wrapJavaScriptModule(code: string, moduleId: string, importedModuleIds: string[], markAsRefreshBoundary: boolean): string {
	const runtimeWrappedCode = replaceImportMetaHot(code);
	const refreshWrapped = wrapModuleWithRefreshRegistrations(runtimeWrappedCode, moduleId);
	const acceptSelf = markAsRefreshBoundary || refreshWrapped.isBoundary;

	return [
		`const __preview_module_id__ = ${JSON.stringify(moduleId)};`,
		`const __preview_runtime__ = window.__PREVIEW_RUNTIME__;`,
		`const __preview_hot__ = __preview_runtime__ ? __preview_runtime__.createHotContext(__preview_module_id__) : undefined;`,
		`if (__preview_runtime__) {`,
		`  __preview_runtime__.registerModule(__preview_module_id__, ${JSON.stringify(importedModuleIds)});`,
		`}`,
		refreshWrapped.code,
		acceptSelf ? `if (__preview_hot__) { __preview_hot__.accept(); }` : '',
	]
		.filter(Boolean)
		.join('\n');
}

export async function transformModule(
	filePath: string,
	content: string,
	options: TransformOptions,
): Promise<{ code: string; contentType: string }> {
	const { fs, projectRoot, projectId, knownDependencies, requestTimestamp } = options;
	const extension = filePath.match(/\.[^.]+$/)?.[0]?.toLowerCase() ?? '';
	const normalizedPath = normalizePreviewPath(filePath);
	const moduleId = toPreviewModuleId(normalizedPath);
	const tsConfig = await getTsConfig(fs, projectRoot, projectId);

	if (['.ts', '.tsx', '.jsx', '.mts'].includes(extension)) {
		const tsconfigRaw = toEsbuildTsconfigRaw(tsConfig);
		const transformed = await transformCode(content, filePath, { sourcemap: true, tsconfigRaw });
		const rewritten = await rewriteImports(
			transformed.code,
			normalizedPath,
			fs,
			projectRoot,
			tsConfig,
			knownDependencies,
			requestTimestamp,
		);
		return {
			code: wrapJavaScriptModule(rewritten.code, moduleId, rewritten.importedModuleIds, false),
			contentType: 'application/javascript',
		};
	}

	if (['.js', '.mjs'].includes(extension)) {
		const rewritten = await rewriteImports(content, normalizedPath, fs, projectRoot, tsConfig, knownDependencies, requestTimestamp);
		return {
			code: wrapJavaScriptModule(rewritten.code, moduleId, rewritten.importedModuleIds, false),
			contentType: 'application/javascript',
		};
	}

	if (isPreviewStylePath(normalizedPath)) {
		const cssContent = JSON.stringify(content);
		const code = [
			`const css = ${cssContent};`,
			`const __preview_module_id__ = ${JSON.stringify(moduleId)};`,
			`const __preview_runtime__ = window.__PREVIEW_RUNTIME__;`,
			`const __preview_hot__ = __preview_runtime__ ? __preview_runtime__.createHotContext(__preview_module_id__) : undefined;`,
			`if (__preview_runtime__) {`,
			`  __preview_runtime__.registerModule(__preview_module_id__, []);`,
			`  __preview_runtime__.upsertStyle(__preview_module_id__, css);`,
			`}`,
			`if (__preview_hot__) { __preview_hot__.accept(); }`,
			`export default css;`,
		].join('\n');
		return { code, contentType: 'application/javascript' };
	}

	if (isPreviewModuleWrappedPath(normalizedPath)) {
		const code = [
			`const __preview_module_id__ = ${JSON.stringify(moduleId)};`,
			`const __preview_runtime__ = window.__PREVIEW_RUNTIME__;`,
			`__preview_runtime__ && __preview_runtime__.createHotContext(__preview_module_id__);`,
			`if (__preview_runtime__) { __preview_runtime__.registerModule(__preview_module_id__, []); }`,
			`export default ${content};`,
		].join('\n');
		return { code, contentType: 'application/javascript' };
	}

	if (isPreviewUrlModulePath(normalizedPath)) {
		const assetUrl = requestTimestamp ? buildPreviewRequest(normalizedPath, { timestamp: requestTimestamp }) : normalizedPath;
		const code = [
			`const __preview_module_id__ = ${JSON.stringify(moduleId)};`,
			`const __preview_runtime__ = window.__PREVIEW_RUNTIME__;`,
			`__preview_runtime__ && __preview_runtime__.createHotContext(__preview_module_id__);`,
			`if (__preview_runtime__) { __preview_runtime__.registerModule(__preview_module_id__, []); }`,
			`export default ${JSON.stringify(assetUrl)};`,
		].join('\n');
		return { code, contentType: 'application/javascript' };
	}

	return { code: content, contentType: getContentType(extension) };
}

function escapeForScriptTag(s: string): string {
	return s
		.replaceAll('\\', '\\\\')
		.replaceAll("'", String.raw`\'`)
		.replaceAll('\n', String.raw`\n`)
		.replaceAll('\r', String.raw`\r`)
		.replaceAll(/<\/(script)/gi, String.raw`<\/$1`);
}

function generatePreviewConfig(wsUrl: string, ideOrigin: string, projectId: string, bootVersion: number): string {
	const safeWsUrl = escapeForScriptTag(wsUrl);
	const safeIdeOrigin = escapeForScriptTag(ideOrigin);
	const safeProjectId = escapeForScriptTag(projectId);
	return `<script>window.__PREVIEW_CONFIG={wsUrl:'${safeWsUrl}',ideOrigin:'${safeIdeOrigin}',projectId:'${safeProjectId}',bootVersion:${String(
		bootVersion,
	)}};</script>`;
}

/**
 * Generate script tags for preview infrastructure.
 *
 * Script order matters:
 * 1. react-refresh-preamble — MUST run before React loads
 * 2. error-overlay — shows build errors
 * 3. preview-runtime — owns module graph + hot updates
 * 4. hmr-client — websocket transport + versioning
 * 5. chobitsu + chobitsu-init — Chrome DevTools Protocol bridge
 */
function generatePreviewScriptTags(integrityHashes?: Record<string, string>): string {
	const scripts = [
		'__react-refresh-preamble.js',
		'__error-overlay.js',
		'__preview-runtime.js',
		'__hmr-client.js',
		'__chobitsu.js',
		'__chobitsu-init.js',
		'__element-picker.js',
	];
	return scripts
		.map((source) => {
			const hash = integrityHashes?.[source];
			const cacheBuster = hash ? `?v=${hash.slice(7, 15)}` : '';
			const integrity = hash ? ` integrity="${hash}"` : '';
			return `<script src="/${source}${cacheBuster}"${integrity}></script>`;
		})
		.join('\n');
}

export interface ProcessHtmlOptions extends TransformOptions {
	wsUrl: string;
	ideOrigin: string;
	projectId: string;
	bootVersion: number;
	scriptIntegrityHashes?: Record<string, string>;
}

function isLocalHtmlReference(reference: string): boolean {
	if (reference.length === 0) return false;
	if (reference.startsWith('#') || reference.startsWith('data:') || reference.startsWith('//')) return false;
	return !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(reference);
}

export async function processHTML(html: string, filePath: string, options: ProcessHtmlOptions): Promise<string> {
	const { wsUrl, ideOrigin, projectId, bootVersion, scriptIntegrityHashes } = options;

	const previewConfig = generatePreviewConfig(wsUrl, ideOrigin, projectId, bootVersion);
	const previewScripts = generatePreviewScriptTags(scriptIntegrityHashes);

	const rewriter = new HTMLRewriter()
		.on('head', {
			element(element) {
				element.append(previewConfig + previewScripts, { html: true });
			},
		})
		.on('script[src]', {
			element(element) {
				const source = element.getAttribute('src');
				if (!source || !isLocalHtmlReference(source)) {
					return;
				}

				const rewrittenPath = normalizePreviewPath(resolvePreviewPath(source, filePath));
				element.setAttribute('src', buildPreviewRequest(rewrittenPath));
			},
		})
		.on('link[rel="stylesheet"][href]', {
			element(element) {
				const href = element.getAttribute('href');
				if (!href || !isLocalHtmlReference(href)) {
					return;
				}

				const rewrittenPath = normalizePreviewPath(resolvePreviewPath(href, filePath));
				element.setAttribute('href', buildPreviewRequest(rewrittenPath));
				// Cloudflare HTMLRewriter elements are not DOM nodes and do not expose `dataset`.
				// eslint-disable-next-line unicorn/prefer-dom-node-dataset
				element.setAttribute('data-preview-id', rewrittenPath);
			},
		});

	const response = rewriter.transform(new Response(html, { headers: { 'Content-Type': 'text/html' } }));

	return response.text();
}
