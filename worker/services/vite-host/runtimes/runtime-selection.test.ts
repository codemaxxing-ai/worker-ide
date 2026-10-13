import { describe, expect, it } from 'vitest';

import { selectBuildBackend } from './runtime-selection';
import templateViteConfig from '../../../fixtures/minimal/vite.config.ts?raw';

describe('build runtime selection', () => {
	it('keeps the simple React template on Workers', () => {
		expect(
			selectBuildBackend({ '/package.json': JSON.stringify({ dependencies: { react: '^19' } }), '/vite.config.ts': templateViteConfig }),
		).toBe('worker');
	});
	it.each(['dependencies', 'devDependencies'])('uses a native container for vinext in %s without requiring a Vite config', (field) => {
		expect(selectBuildBackend({ '/package.json': JSON.stringify({ [field]: { vinext: '^0.1.8' } }) })).toBe('container');
	});
	it('runs custom Vite configuration through native Vite', () => {
		expect(selectBuildBackend({ '/vite.config.mts': 'export default { plugins: [customPlugin()] }' })).toBe('container');
	});
	it('uses a container when a project declares additional Vite plugins', () => {
		expect(selectBuildBackend({ 'package.json': JSON.stringify({ devDependencies: { 'vite-plugin-custom': '^1' } }) })).toBe('container');
	});
	it('honors an explicit runtime for a static project', () => {
		expect(selectBuildBackend({ 'package.json': JSON.stringify({ workerIde: { runtime: 'container' } }) })).toBe('container');
		expect(selectBuildBackend({ 'package.json': JSON.stringify({ workerIde: { runtime: 'worker' } }), 'vite.config.ts': 'custom' })).toBe(
			'worker',
		);
	});
});
