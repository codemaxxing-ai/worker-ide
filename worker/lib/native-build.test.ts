import { describe, expect, it } from 'vitest';

import { nativeBuildSchema } from './native-build';

describe('native build boundary', () => {
	it('accepts binary assets and a complete Worker module set', () => {
		expect(
			nativeBuildSchema.parse({
				clientFiles: { 'assets/image.png': 'AP+AKg==' },
				mainModule: 'index.js',
				serverModules: { 'index.js': 'export default {}' },
			}),
		).toBeDefined();
	});
	it.each(['/absolute.js', '../escape.js', 'assets/../escape.js', String.raw`assets\escape.js`])(
		'rejects output escaping the asset root: %s',
		(filename) => {
			expect(nativeBuildSchema.safeParse({ clientFiles: { [filename]: 'YQ==' } }).success).toBe(false);
		},
	);
	it('rejects malformed binary data and incomplete server builds', () => {
		expect(nativeBuildSchema.safeParse({ clientFiles: { 'image.png': 'binary?' } }).success).toBe(false);
		expect(nativeBuildSchema.safeParse({ clientFiles: {}, mainModule: 'missing.js', serverModules: {} }).success).toBe(false);
		expect(nativeBuildSchema.safeParse({ clientFiles: {}, mainModule: 'index.js' }).success).toBe(false);
	});
});
