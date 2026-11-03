import { describe, expect, it } from 'vitest';

import { selectRuntime } from './registry';
import { assertWorkerCapabilities } from './runtime-selection';
import templateViteConfig from '../../../fixtures/minimal/vite.config.ts?raw';

describe('Worker-first runtime selection', () => {
	it('keeps the simple template and unused plugin dependencies on Workers', () => {
		const files = {
			'/package.json': JSON.stringify({ devDependencies: { 'vite-plugin-custom': '^1' } }),
			'/vite.config.ts': templateViteConfig,
		};
		expect(selectRuntime({ files }).id).toBe('react-spa');
		expect(() => assertWorkerCapabilities(files)).not.toThrow();
	});
	it.each(['dependencies', 'devDependencies'])('starts vinext declared in %s on Workers', (field) => {
		const files = {
			'/package.json': JSON.stringify({ [field]: { vinext: '^0.1.8' } }),
			'/app/page.tsx': 'export default function Page() {}',
		};
		expect(selectRuntime({ files }).id).toBe('vinext');
		expect(() => assertWorkerCapabilities(files)).not.toThrow();
	});
	it('detects unsupported configuration at compile time', () => {
		const files = { '/vite.config.mts': 'export default { resolve: { alias: { custom: "/src/custom" } } }' };
		expect(selectRuntime({ files }).id).toBe('react-spa');
		expect(() => assertWorkerCapabilities(files)).toThrow('WORKER_CAPABILITY_REQUIRED');
	});
	it('preserves invalid configuration as a syntax error', () => {
		expect(() => assertWorkerCapabilities({ '/vite.config.ts': 'export default {' })).toThrow(SyntaxError);
	});
	it('requires native support for a router the Worker adapter cannot render', () => {
		expect(() =>
			assertWorkerCapabilities({ '/package.json': JSON.stringify({ dependencies: { vinext: '^0.1.8' } }), '/src/app/page.tsx': '' }),
		).toThrow('WORKER_CAPABILITY_REQUIRED');
	});
	it('keeps missing application routes as an error', () => {
		expect(() => assertWorkerCapabilities({ '/package.json': JSON.stringify({ dependencies: { vinext: '^0.1.8' } }) })).toThrow(
			'vinext requires an app or pages directory',
		);
	});
	it.each(['worker', 'container'])('ignores legacy %s manifest overrides without modifying files', (runtime) => {
		const files = { '/package.json': JSON.stringify({ workerIde: { runtime } }) };
		const original = { ...files };
		expect(selectRuntime({ files }).id).toBe('react-spa');
		expect(() => assertWorkerCapabilities(files)).not.toThrow();
		expect(files).toEqual(original);
	});
});
