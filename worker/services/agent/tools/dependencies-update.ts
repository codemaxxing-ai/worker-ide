import { stripIndent } from 'common-tags';

import { ToolExecutionError } from '@shared/tool-errors';
import { coordinatorNamespace } from '@worker/lib/durable-object-namespaces';
import { fs } from '@worker/lib/project-fs';
import { readDependencies, regenerateProtectedFiles, writeDependencies } from '@worker/lib/protected-files';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext, ToolResult } from '../types';

export const definition: ToolDefinition = {
	name: 'dependencies_update',
	description: stripIndent`
		Add, remove, or update a project dependency. Dependencies are stored in package.json.
		Use this tool instead of npm install, bun add, or editing the protected package.json. The IDE resolves packages for Worker previews and installs them for container previews and builds.
		CRITICAL INSTRUCTION: You MUST register a dependency before importing it in code. Use dependencies_list to see current dependencies.
	`,
	input_schema: {
		type: 'object',
		properties: {
			action: {
				type: 'string',
				description: 'The action to perform: "add", "remove", or "update"',
				enum: ['add', 'remove', 'update'],
			},
			name: {
				type: 'string',
				description: 'The npm package name (e.g. "hono", "@scope/pkg")',
			},
			version: {
				type: 'string',
				description: 'The version specifier (e.g. "^4.0.0", "*"). Defaults to "*" when adding.',
			},
		},
		required: ['action', 'name'],
	},
};

export async function execute(
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
): Promise<ToolResult> {
	const { projectRoot } = context;
	const { action, name, version } = input;

	if (!name) {
		throw new ToolExecutionError('MISSING_INPUT', 'Package name is required.');
	}

	sendEvent('status', { message: `Updating dependency: ${name}...` });

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

	// Notify connected clients so the dependencies panel refreshes immediately.
	const coordinatorStub = coordinatorNamespace.getByName(`project:${context.projectId}`);
	await coordinatorStub.triggerUpdate({ type: 'full-reload', path: '/package.json', timestamp: Date.now(), targets: [] });

	const verbMap: Record<string, string> = { add: 'Added', remove: 'Removed', update: 'Updated' };
	const verb = verbMap[action] ?? action;

	return {
		title: name,
		metadata: { action, name, version: removedVersion ?? dependencies[name], dependencies },
		output: action === 'remove' ? `${verb} ${name}` : `${verb} ${name}@${dependencies[name] || '*'}`,
	};
}
