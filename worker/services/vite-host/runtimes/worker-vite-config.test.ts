import { describe, expect, it } from 'vitest';

import { assertWorkerViteConfig } from './worker-vite-config';

describe('Worker Vite configuration support', () => {
	it.each([
		'export default {}',
		'export default { plugins: [] }',
		`import { defineConfig } from 'vite'; export default defineConfig({});`,
		`import react from '@vitejs/plugin-react'; export default { plugins: [react()] };`,
		`import { cloudflare } from '@cloudflare/vite-plugin'; export default { plugins: [cloudflare()] };`,
		`import vinext from 'vinext'; export default { plugins: [vinext()] };`,
		`// Formatting and aliases do not change host requirements.
		import { defineConfig as config } from "vite";
		import framework from "vinext";
		export default config({ "plugins": [framework({})] });`,
	])('accepts supported static configuration: %s', (source) => {
		expect(() => assertWorkerViteConfig(source, 'vite.config.ts')).not.toThrow();
	});

	it.each([
		[`import custom from 'vite-plugin-custom'; export default { plugins: [custom()] };`, 'plugin vite-plugin-custom'],
		[`import * as custom from 'vite-plugin-custom'; export default custom.config;`, 'plugin vite-plugin-custom'],
		[
			`import react from '@vitejs/plugin-react'; export default { plugins: [react({ jsxImportSource: 'custom' })] };`,
			'options for @vitejs/plugin-react',
		],
		['export default { resolve: { alias: { custom: "/src/custom" } } };', 'option resolve'],
		[`import { defineConfig } from 'vite'; export default defineConfig(() => ({}));`, 'dynamic configuration'],
		['const plugins = []; export default { plugins };', 'executing configuration code'],
		[`import './setup'; export default {};`, 'plugin ./setup'],
	])('identifies the unsupported capability: %s', (source, capability) => {
		expect(() => assertWorkerViteConfig(source, 'vite.config.ts')).toThrow(`WORKER_CAPABILITY_REQUIRED: vite.config.ts: ${capability}`);
	});

	it('keeps invalid syntax and undefined plugin references as errors', () => {
		expect(() => assertWorkerViteConfig('export default {', 'vite.config.ts')).toThrow(SyntaxError);
		expect(() => assertWorkerViteConfig('export default { plugins: [missing()] }', 'vite.config.ts')).toThrow(ReferenceError);
		expect(() => assertWorkerViteConfig(`import { defineConfig } from 'vite';`, 'vite.config.ts')).toThrow('missing default export');
	});
});
