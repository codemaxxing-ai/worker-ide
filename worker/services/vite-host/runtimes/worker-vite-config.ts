import { Parser } from 'acorn';
import { tsPlugin } from 'acorn-typescript';

import { WorkerCapabilityError } from '@shared/worker-runtime-error';

import type { ExportDefaultDeclaration, Expression, ObjectExpression, SpreadElement } from 'acorn';

// @ts-expect-error -- acorn-typescript's published plugin signature differs from acorn's compatible runtime API.
const ConfigurationParser = Parser.extend(tsPlugin());

const SUPPORTED_IMPORTS: Record<string, string> = {
	vite: 'defineConfig',
	'@vitejs/plugin-react': 'default',
	'@cloudflare/vite-plugin': 'cloudflare',
	vinext: 'default',
};

/**
 * The Worker host implements these default plugins itself. Accept their static
 * configuration without executing project code; other options need native Vite.
 */
export function assertWorkerViteConfig(source: string, filename: string): void {
	// Parse the entire module first: invalid configuration is always a syntax error.
	const program = ConfigurationParser.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
	const imports = new Map<string, string>();
	let exported: ExportDefaultDeclaration | undefined;
	function unsupported(capability: string): never {
		throw new WorkerCapabilityError(`${filename}: ${capability}`);
	}
	for (const statement of program.body) {
		if (statement.type === 'EmptyStatement') continue;
		if (statement.type === 'ExportDefaultDeclaration') {
			exported = statement;
			continue;
		}
		if (statement.type !== 'ImportDeclaration') unsupported('executing configuration code requires native Vite');
		const moduleName = String(statement.source.value);
		const supportedImport = SUPPORTED_IMPORTS[moduleName];
		if (!supportedImport) unsupported(`plugin ${moduleName} requires native Vite`);
		if (statement.specifiers.length === 0) unsupported(`importing ${moduleName} for side effects requires native Vite`);
		for (const specifier of statement.specifiers) {
			const imported =
				specifier.type === 'ImportDefaultSpecifier'
					? 'default'
					: specifier.type === 'ImportSpecifier' && specifier.imported.type === 'Identifier'
						? specifier.imported.name
						: undefined;
			if (imported !== supportedImport) unsupported(`import from ${moduleName} requires native Vite`);
			imports.set(specifier.local.name, moduleName);
		}
	}
	if (!exported) throw new Error(`${filename}: missing default export`);
	let configuration = exported.declaration;
	if (configuration.type === 'CallExpression' && configuration.callee.type === 'Identifier') {
		if (imports.get(configuration.callee.name) !== 'vite' || configuration.arguments.length !== 1)
			unsupported('configuration factory requires native Vite');
		const argument = configuration.arguments[0];
		if (argument.type !== 'ObjectExpression') unsupported('dynamic configuration requires native Vite');
		configuration = argument;
	}
	if (configuration.type !== 'ObjectExpression') unsupported('dynamic configuration requires native Vite');
	assertOptions(configuration, imports, unsupported);
}

function assertOptions(configuration: ObjectExpression, imports: Map<string, string>, unsupported: (capability: string) => never): void {
	for (const property of configuration.properties) {
		if (property.type !== 'Property' || property.computed || property.method || property.kind !== 'init')
			unsupported('computed options require native Vite');
		const key = property.key.type === 'Identifier' ? property.key.name : property.key.type === 'Literal' ? property.key.value : undefined;
		if (key !== 'plugins' || property.value.type !== 'ArrayExpression') unsupported(`option ${String(key)} requires native Vite`);
		for (const plugin of property.value.elements) {
			if (!plugin || plugin.type !== 'CallExpression' || plugin.callee.type !== 'Identifier')
				unsupported('dynamic plugins require native Vite');
			const moduleName = imports.get(plugin.callee.name);
			if (!moduleName) throw new ReferenceError(`${plugin.callee.name} is not defined`);
			if (moduleName === 'vite') unsupported('invalid plugin factory');
			if (plugin.arguments.some((argument) => !isEmptyOptions(argument))) unsupported(`options for ${moduleName} require native Vite`);
			if (plugin.arguments.length > 1) unsupported(`arguments for ${moduleName} require native Vite`);
		}
	}
}

function isEmptyOptions(expression: Expression | SpreadElement): boolean {
	return expression.type === 'ObjectExpression' && expression.properties.length === 0;
}
