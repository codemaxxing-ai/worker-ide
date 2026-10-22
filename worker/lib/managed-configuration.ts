import { ToolExecutionError } from '@shared/tool-errors';

import { fs } from './project-fs';
import {
	readDependencies,
	writeDependencies,
	readAssetSettings,
	writeAssetSettings,
	readBindingsConfig,
	writeBindingsConfig,
	regenerateProtectedFiles,
} from './protected-files';

import type { ToolResult } from '../services/agent/types';
import type { AssetSettings, HtmlHandling, NotFoundHandling, BindingsConfig } from '@shared/types';

export type ManagedConfigurationTool = 'dependencies_update' | 'asset_settings_update' | 'bindings_update';

export function applyManagedConfiguration(
	toolName: ManagedConfigurationTool,
	input: Record<string, string>,
	projectRoot: string,
): Promise<ToolResult> {
	switch (toolName) {
		case 'dependencies_update': {
			return applyDependencyUpdate(input, projectRoot);
		}
		case 'asset_settings_update': {
			return applyAssetSettingsUpdate(input, projectRoot);
		}
		case 'bindings_update': {
			return applyBindingsUpdate(input, projectRoot);
		}
		default: {
			throw new Error('Unknown managed configuration operation');
		}
	}
}

const VALID_NOT_FOUND_HANDLING: Record<string, NotFoundHandling> = {
	none: 'none',
	'single-page-application': 'single-page-application',
	'404-page': '404-page',
};

const VALID_HTML_HANDLING: Record<string, HtmlHandling> = {
	'auto-trailing-slash': 'auto-trailing-slash',
	'force-trailing-slash': 'force-trailing-slash',
	'drop-trailing-slash': 'drop-trailing-slash',
	none: 'none',
};

async function applyDependencyUpdate(input: Record<string, string>, projectRoot: string): Promise<ToolResult> {
	const { action, name, version } = input;

	if (!name) {
		throw new ToolExecutionError('MISSING_INPUT', 'Package name is required.');
	}

	// Verify package.json exists
	try {
		await fs.access(`${projectRoot}/package.json`);
	} catch {
		throw new ToolExecutionError('FILE_NOT_FOUND', 'No package.json found. Cannot manage dependencies.');
	}

	const dependencies = await readDependencies(projectRoot);
	let removedVersion: string | undefined;

	switch (action) {
		case 'add': {
			if (dependencies[name]) {
				throw new ToolExecutionError(
					'NOT_ALLOWED',
					`Dependency "${name}" already exists with version "${dependencies[name]}". Use action "update" to change it.`,
				);
			}
			dependencies[name] = version || '*';
			break;
		}
		case 'remove': {
			if (!dependencies[name]) {
				throw new ToolExecutionError('NOT_ALLOWED', `Dependency "${name}" is not registered.`);
			}
			removedVersion = dependencies[name];
			delete dependencies[name];
			break;
		}
		case 'update': {
			if (!dependencies[name]) {
				throw new ToolExecutionError('NOT_ALLOWED', `Dependency "${name}" is not registered. Use action "add" to add it first.`);
			}
			dependencies[name] = version || '*';
			break;
		}
		default: {
			throw new ToolExecutionError('MISSING_INPUT', `Unknown action "${action}". Use "add", "remove", or "update".`);
		}
	}

	await writeDependencies(projectRoot, dependencies);

	// Regenerate all protected files so vite.config.ts, devDependencies, etc. stay in sync
	await regenerateProtectedFiles(projectRoot);

	const verbMap: Record<string, string> = { add: 'Added', remove: 'Removed', update: 'Updated' };
	const verb = verbMap[action] ?? action;

	return {
		title: name,
		metadata: { action, name, version: removedVersion ?? dependencies[name], dependencies },
		output: action === 'remove' ? `${verb} ${name}` : `${verb} ${name}@${dependencies[name] || '*'}`,
	};
}

async function applyAssetSettingsUpdate(input: Record<string, string>, projectRoot: string): Promise<ToolResult> {
	const assetSettings: AssetSettings = await readAssetSettings(projectRoot);
	const changes: string[] = [];

	// Update not_found_handling
	if (input.not_found_handling !== undefined) {
		const parsedNotFound = VALID_NOT_FOUND_HANDLING[input.not_found_handling];
		if (!parsedNotFound) {
			throw new ToolExecutionError(
				'NOT_ALLOWED',
				`Invalid not_found_handling: "${input.not_found_handling}". Must be one of: none, single-page-application, 404-page`,
			);
		}
		if (parsedNotFound === 'none') {
			delete assetSettings.not_found_handling;
		} else {
			assetSettings.not_found_handling = parsedNotFound;
		}
		changes.push(`not_found_handling = ${input.not_found_handling}`);
	}

	// Update html_handling
	if (input.html_handling !== undefined) {
		const parsedHtml = VALID_HTML_HANDLING[input.html_handling];
		if (!parsedHtml) {
			throw new ToolExecutionError(
				'NOT_ALLOWED',
				`Invalid html_handling: "${input.html_handling}". Must be one of: auto-trailing-slash, force-trailing-slash, drop-trailing-slash, none`,
			);
		}
		if (parsedHtml === 'auto-trailing-slash') {
			delete assetSettings.html_handling;
		} else {
			assetSettings.html_handling = parsedHtml;
		}
		changes.push(`html_handling = ${input.html_handling}`);
	}

	// Update run_worker_first
	if (input.run_worker_first !== undefined) {
		const value = input.run_worker_first.trim();
		if (value === 'true') {
			assetSettings.run_worker_first = true;
			changes.push('run_worker_first = true');
		} else if (value === 'false') {
			delete assetSettings.run_worker_first;
			changes.push('run_worker_first = false');
		} else {
			// Parse as comma-separated patterns
			const patterns = value
				.split(',')
				.map((p) => p.trim())
				.filter(Boolean);

			for (const pattern of patterns) {
				if (!pattern.startsWith('/') && !pattern.startsWith('!/')) {
					throw new ToolExecutionError('NOT_ALLOWED', `Invalid route pattern: "${pattern}". Patterns must begin with / or !/`);
				}
			}

			assetSettings.run_worker_first = patterns;
			changes.push(`run_worker_first = [${patterns.join(', ')}]`);
		}
	}

	if (changes.length === 0) {
		return {
			title: 'no changes',
			metadata: { assetSettings },
			output: 'No settings were provided to update.',
		};
	}

	// Write asset settings to wrangler.jsonc
	const cleanedSettings = Object.keys(assetSettings).length > 0 ? assetSettings : {};
	await writeAssetSettings(projectRoot, cleanedSettings);

	// Regenerate all protected files to keep them in sync
	await regenerateProtectedFiles(projectRoot);

	return {
		title: 'asset settings updated',
		metadata: { assetSettings: cleanedSettings, changes },
		output: `Updated asset settings:\n${changes.join('\n')}`,
	};
}

async function applyBindingsUpdate(input: Record<string, string>, projectRoot: string): Promise<ToolResult> {
	const bindingsConfig: BindingsConfig = await readBindingsConfig(projectRoot);
	const changes: string[] = [];

	if (input.storage !== undefined) {
		const value = input.storage.trim().toLowerCase();
		if (value !== 'true' && value !== 'false') {
			throw new ToolExecutionError('NOT_ALLOWED', `Invalid storage value: "${input.storage}". Must be "true" or "false"`);
		}
		const enabled = value === 'true';
		bindingsConfig.storage = enabled || undefined;
		changes.push(`storage = ${enabled ? 'enabled' : 'disabled'}`);
	}

	if (changes.length === 0) {
		return {
			title: 'no changes',
			metadata: { bindingsConfig },
			output: 'No bindings were provided to update.',
		};
	}

	await writeBindingsConfig(projectRoot, bindingsConfig);
	await regenerateProtectedFiles(projectRoot);

	return {
		title: 'bindings updated',
		metadata: { bindingsConfig, changes },
		output: `Updated bindings:\n${changes.join('\n')}`,
	};
}
