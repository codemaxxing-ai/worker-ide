import { z } from 'zod';

import { MAX_PROJECT_NAME_LENGTH } from '../constants';

const NPM_PACKAGE_NAME_PATTERN = /^(?:@[\da-z~-][\d._a-z~-]*\/)?[\da-z~-][\d._a-z~-]*$/;

const DEPENDENCY_VERSION_PATTERN =
	/^(?:\*|latest|(?:[~^]|[<>]=?)?(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*|x))?(?:\.(?:0|[1-9]\d*|x))?(?:-[\d.a-z-]+)?(?:\+[\d.a-z-]+)?)$/;
export function validateDependencyName(name: string): string | undefined {
	const trimmed = name.trim();
	if (trimmed.length === 0) {
		return 'Dependency name is required';
	}
	if (trimmed.length > 214) {
		return 'Dependency name must be at most 214 characters';
	}
	if (!NPM_PACKAGE_NAME_PATTERN.test(trimmed)) {
		return `Invalid package name`;
	}
	return undefined;
}
export function validateDependencyVersion(version: string): string | undefined {
	const trimmed = version.trim();
	if (trimmed.length === 0) {
		return 'Version is required';
	}
	if (!DEPENDENCY_VERSION_PATTERN.test(trimmed)) {
		return `Invalid version, use * for latest.`;
	}
	return undefined;
}
export const assetSettingsSchema = z.object({
	not_found_handling: z.enum(['none', 'single-page-application', '404-page']).optional(),
	html_handling: z.enum(['auto-trailing-slash', 'force-trailing-slash', 'drop-trailing-slash', 'none']).optional(),
	run_worker_first: z.union([z.boolean(), z.array(z.string().regex(/^!?\//, 'Patterns must begin with / or !/'))]).optional(),
});

export type AssetSettingsInput = z.infer<typeof assetSettingsSchema>;
export const bindingsConfigSchema = z.object({
	storage: z.boolean().optional(),
});

export type BindingsConfigInput = z.infer<typeof bindingsConfigSchema>;

export const projectMetaSchema = z.object({
	name: z
		.string()
		.min(1, 'Name is required')
		.max(MAX_PROJECT_NAME_LENGTH, `Name must be at most ${MAX_PROJECT_NAME_LENGTH} characters`)
		.optional(),
	assetSettings: assetSettingsSchema.optional(),
	bindingsConfig: bindingsConfigSchema.optional(),
});

export const dependenciesUpdateSchema = z.object({
	dependencies: z.record(z.string(), z.string()),
});

export const favoriteBodySchema = z.object({
	favorite: z.boolean(),
});

export const visibilityBodySchema = z.object({
	visibility: z.enum(['public', 'private']),
});

export const transferInitiateBodySchema = z.object({
	targetOrganizationId: z.string().min(1),
});
