import { describe, expect, it } from 'vitest';

import { buildDetectionProbe } from './preview-bootstrap';

import type { PreviewBootstrap } from './preview-bootstrap';

function bootstrap(overrides: Partial<PreviewBootstrap> = {}): PreviewBootstrap {
	return {
		exists: true,
		wranglerJsonc: undefined,
		packageJson: undefined,
		indexHtml: undefined,
		routerFirstEntries: {},
		snapshotHash: '',
		configurationFiles: {},
		runtimeDecision: { backend: 'worker', reason: 'simple-project', generation: 1 },
		...overrides,
	};
}

describe('buildDetectionProbe', () => {
	it('returns an empty probe when there is no package.json (not detectable)', () => {
		const probe = buildDetectionProbe(bootstrap({ indexHtml: '<html></html>', routerFirstEntries: { app: 'page.tsx' } }));
		expect(probe.files).toEqual({});
	});

	it('includes the manifest and optional index.html', () => {
		const probe = buildDetectionProbe(bootstrap({ packageJson: '{"name":"x"}', indexHtml: '<html></html>' }));
		expect(probe.files).toEqual({ '/package.json': '{"name":"x"}', '/index.html': '<html></html>' });
	});

	it('omits index.html when absent', () => {
		const probe = buildDetectionProbe(bootstrap({ packageJson: '{}' }));
		expect(probe.files).toEqual({ '/package.json': '{}' });
	});

	it('adds each router directory first entry as an empty-content marker', () => {
		const probe = buildDetectionProbe(
			bootstrap({ packageJson: '{}', routerFirstEntries: { app: 'page.tsx', pages: undefined, src: 'main.tsx' } }),
		);
		expect(probe.files).toEqual({ '/package.json': '{}', '/app/page.tsx': '', '/src/main.tsx': '' });
	});
});
