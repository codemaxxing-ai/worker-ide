import { describe, expect, it } from 'vitest';

import { classifyOrigin, createDomainConfiguration } from '@shared/domain';

import { assertSafeExternalUrl, buildAllowedPreviewOrigins } from './network-policy';

const origins = createDomainConfiguration('https://codemaxxing.app', 'https://codemaxxing.net');

describe('agent deployment access boundary', () => {
	it.each([
		'https://codemaxxing.app/api',
		'https://git.codemaxxing.app/repo',
		'https://codemaxxing.net/',
		'https://other-project.codemaxxing.net/api',
	])('blocks generic egress to %s', (url) => {
		expect(() => assertSafeExternalUrl(new URL(url), origins)).toThrow(/preview_fetch/);
	});
	it('allows ordinary external resources', () => {
		expect(() => assertSafeExternalUrl(new URL('https://registry.npmjs.org/react'), origins)).not.toThrow();
	});
	it('grants privileged browser access only to this project’s two live signed origins', async () => {
		const allowed = await buildAllowedPreviewOrigins('project123', origins, 'test-secret');
		expect(allowed).toHaveLength(2);
		for (const origin of allowed) expect(classifyOrigin(origin, origins)).toMatchObject({ type: 'preview', projectId: 'project123' });
		const sibling = await buildAllowedPreviewOrigins('project456', origins, 'test-secret');
		for (const origin of sibling) expect(allowed).not.toContain(origin);
	});
});
