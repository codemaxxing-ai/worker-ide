import { describe, expect, it, vi } from 'vitest';

vi.mock('./bundler-client', () => ({
	transformCode: vi.fn(async (code: string) => ({ code })),
}));

import { rewriteExternalModuleImports, transformModule } from './transform-service';

function createFileSystem(existingPaths: string[]) {
	const knownPaths = new Set(existingPaths);
	return {
		readFile: vi.fn(async () => {
			throw new Error('Unexpected readFile call');
		}),
		access: vi.fn(async (path: string) => {
			if (!knownPaths.has(path)) {
				throw new Error(`ENOENT: ${path}`);
			}
		}),
	};
}

function createProjectOptions(projectId: string, directory: string) {
	const fileSystem = createFileSystem([`/project/${directory}/value.js`]);
	return {
		projectId,
		projectRoot: '/project',
		fs: {
			...fileSystem,
			readFile: async () => JSON.stringify({ compilerOptions: { baseUrl: '/', paths: { '@app/*': [`${directory}/*`] } } }),
		},
	};
}

describe('transformModule', () => {
	it('does not reuse another project configuration at the same filesystem root', async () => {
		const source = 'import value from "@app/value";';
		const first = await transformModule('/main.js', source, createProjectOptions('project-one', 'one'));
		const second = await transformModule('/main.js', source, createProjectOptions('project-two', 'two'));
		expect(first.code).toContain('from "/one/value.js"');
		expect(second.code).toContain('from "/two/value.js"');
	});

	it('rewrites local imports to explicit preview module ids', async () => {
		const fileSystem = createFileSystem(['/project/src/style.css', '/project/src/data.json', '/project/src/logo.png']);

		const result = await transformModule(
			'/src/main.tsx',
			[
				'import { jsx } from "react/jsx-runtime";',
				'import "./style.css";',
				'import data from "./data.json";',
				'import logo from "./logo.png";',
				'export function App() {',
				'	return jsx("div", { children: logo + data.name });',
				'}',
			].join('\n'),
			{ fs: fileSystem, projectRoot: '/project', projectId: 'transform-tests' },
		);

		expect(result.contentType).toBe('application/javascript');
		expect(result.code).toContain('/src/style.css?mode=module');
		expect(result.code).toContain('/src/data.json?mode=module');
		expect(result.code).toContain('/src/logo.png?mode=url');
		expect(result.code).toContain('/__preview_external?url=https%3A%2F%2Fesm.sh%2Freact%2Fjsx-runtime%3Fdev');
		expect(result.code).toContain('createHotContext(__preview_module_id__)');
		expect(result.code).toContain('registerModule(__preview_module_id__');
	});

	it('uses registered dependency versions for preview bare imports', async () => {
		const fileSystem = createFileSystem([]);

		const result = await transformModule('/src/main.tsx', 'import { createRoot } from "react-dom/client";', {
			fs: fileSystem,
			projectRoot: '/project',
			projectId: 'transform-tests',
			knownDependencies: new Map([
				['react', '^19.2.4'],
				['react-dom', '^19.2.4'],
			]),
		});

		expect(result.code).toContain('/__preview_external?url=https%3A%2F%2Fesm.sh%2Freact-dom%40%255E19.2.4%2Fclient%3Fdev');
	});

	it('throws for unregistered preview bare imports when project dependencies are provided', async () => {
		const fileSystem = createFileSystem([]);

		await expect(
			transformModule('/src/main.tsx', 'import { createRoot } from "react-dom/client";', {
				fs: fileSystem,
				projectRoot: '/project',
				projectId: 'transform-tests',
				knownDependencies: new Map([['react', '^19.2.4']]),
			}),
		).rejects.toThrow('Unregistered dependency "react-dom". Add it to project dependencies using the Dependencies panel.');
	});

	it('wraps css files as self-accepting style modules', async () => {
		const result = await transformModule('/src/style.css', 'body { color: red; }', {
			fs: createFileSystem([]),
			projectRoot: '/project',
			projectId: 'transform-tests',
		});

		expect(result.contentType).toBe('application/javascript');
		expect(result.code).toContain('/src/style.css?mode=module');
		expect(result.code).toContain('upsertStyle(__preview_module_id__, css)');
		expect(result.code).toContain('__preview_hot__.accept()');
	});

	it('self-accepts modules whose exports are all React components', async () => {
		const result = await transformModule('/src/button.tsx', ['export function Button() {', '	return null;', '}'].join('\n'), {
			fs: createFileSystem([]),
			projectRoot: '/project',
			projectId: 'transform-tests',
		});

		expect(result.code).toContain('__preview_hot__.accept()');
	});

	it('does not self-accept modules that also export non-component values', async () => {
		const result = await transformModule(
			'/src/widget.tsx',
			['export function Widget() {', '	return null;', '}', 'export const helper = () => 42;'].join('\n'),
			{
				fs: createFileSystem([]),
				projectRoot: '/project',
				projectId: 'transform-tests',
			},
		);

		expect(result.code).not.toContain('__preview_hot__.accept()');
	});

	it('does not self-accept modules that re-export with a wildcard', async () => {
		const result = await transformModule(
			'/src/barrel.tsx',
			['export function Panel() {', '	return null;', '}', "export * from './helpers';"].join('\n'),
			{
				fs: createFileSystem([]),
				projectRoot: '/project',
				projectId: 'transform-tests',
			},
		);

		expect(result.code).not.toContain('__preview_hot__.accept()');
	});

	it('exports cache-busted asset urls from url modules', async () => {
		const result = await transformModule('/src/logo.png', 'binary', {
			fs: createFileSystem([]),
			projectRoot: '/project',
			projectId: 'transform-tests',
			requestTimestamp: '42',
		});

		expect(result.code).toContain('export default "/src/logo.png?t=42";');
		expect(result.code).toContain('/src/logo.png?mode=url');
	});

	it('rewrites external module source imports through the preview proxy', () => {
		const rewritten = rewriteExternalModuleImports(
			[
				'import*as React from"/react@19.0.0/es2022/react.mjs";',
				'import "/react@19.0.0/es2022/react.mjs";',
				'export { hydrateRoot } from "./client.mjs";',
				'const runtime = import("https://esm.sh/react/jsx-runtime");',
			].join('\n'),
			'https://esm.sh/react-dom@19.0.0/client',
			'77',
		);

		expect(rewritten).toContain('/__preview_external?url=https%3A%2F%2Fesm.sh%2Freact%4019.0.0%2Fes2022%2Freact.mjs');
		expect(rewritten).toContain('/__preview_external?url=https%3A%2F%2Fesm.sh%2Freact-dom%4019.0.0%2Fclient.mjs');
		expect(rewritten).toContain('/__preview_external?url=https%3A%2F%2Fesm.sh%2Freact%2Fjsx-runtime%3Fdev');
		expect(rewritten).not.toContain('&t=77');
	});
});
