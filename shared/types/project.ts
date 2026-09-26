import { type FileInfo } from './file-system';

/**
 * Metadata for a project template (without file contents).
 * Used by both the GET /api/templates endpoint and the dashboard page.
 */
export interface ProjectTemplateMeta {
	id: string;
	name: string;
	description: string;
	icon: string;
}
export interface FilesResponse {
	files: FileInfo[];
}
export interface FileResponse {
	path: string;
	content: string;
}
export interface ExpirationResponse {
	expiresAt?: number;
	expiresIn?: number;
}
export interface NewProjectResponse {
	projectId: string;
	url: string;
	name: string;
}

/**
 * Cloudflare Workers asset routing configuration.
 * @see https://developers.cloudflare.com/workers/static-assets/
 */
export type NotFoundHandling = 'none' | 'single-page-application' | '404-page';
export type HtmlHandling = 'auto-trailing-slash' | 'force-trailing-slash' | 'drop-trailing-slash' | 'none';

export interface AssetSettings {
	not_found_handling?: NotFoundHandling;
	html_handling?: HtmlHandling;
	run_worker_first?: boolean | string[];
}

export interface ResolvedAssetSettings {
	not_found_handling: NotFoundHandling;
	html_handling: HtmlHandling;
	run_worker_first: boolean | string[];
}

export function resolveAssetSettings(settings?: AssetSettings): ResolvedAssetSettings {
	return {
		not_found_handling: settings?.not_found_handling ?? 'none',
		html_handling: settings?.html_handling ?? 'auto-trailing-slash',
		run_worker_first: settings?.run_worker_first ?? false,
	};
}

/**
 * Bindings configuration stored in wrangler.jsonc.
 * Controls which bindings are injected into the user's worker env.
 */
export interface BindingsConfig {
	storage?: boolean;
}
