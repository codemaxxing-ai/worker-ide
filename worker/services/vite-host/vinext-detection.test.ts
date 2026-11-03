import { describe, expect, it } from 'vitest';

import { isVinextProject } from './vinext-detection';

const vinextManifest = JSON.stringify({ name: 'demo', dependencies: { vinext: '^0.1.0' } });

describe('isVinextProject', () => {
	it('detects an App Router vinext project', () => {
		expect(
			isVinextProject({
				'/package.json': vinextManifest,
				'/app/page.tsx': 'export default function Page() { return null; }',
			}),
		).toBe(true);
	});

	it('detects a Pages Router vinext project', () => {
		expect(
			isVinextProject({
				'/package.json': vinextManifest,
				'/pages/index.tsx': 'export default function Home() { return null; }',
			}),
		).toBe(true);
	});

	it('detects vinext declared as a devDependency', () => {
		expect(
			isVinextProject({
				'/package.json': JSON.stringify({ devDependencies: { vinext: '^0.1.0' } }),
				'/app/page.tsx': 'export default () => null;',
			}),
		).toBe(true);
	});

	it('accepts paths without a leading slash', () => {
		expect(
			isVinextProject({
				'package.json': vinextManifest,
				'app/page.tsx': 'export default () => null;',
			}),
		).toBe(true);
	});

	it('returns false when vinext is not a dependency', () => {
		expect(
			isVinextProject({
				'/package.json': JSON.stringify({ dependencies: { react: '^19.0.0' } }),
				'/app/page.tsx': 'export default () => null;',
			}),
		).toBe(false);
	});

	it('leaves router discovery and validation to the selected host', () => {
		expect(isVinextProject({ '/package.json': vinextManifest })).toBe(true);
	});

	it('returns false when there is no package.json', () => {
		expect(isVinextProject({ '/app/page.tsx': 'export default () => null;' })).toBe(false);
	});

	it('returns false for an unparseable package.json', () => {
		expect(isVinextProject({ '/package.json': '{ not json', '/app/page.tsx': 'x' })).toBe(false);
	});
});
