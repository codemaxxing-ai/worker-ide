import { describe, expect, it } from 'vitest';

import { buildGitOrigin, buildPreviewOrigin, classifyOrigin, createDomainConfiguration } from './domain';

const projectId = '494rtk7ddoepe5ru2lx4oc855i6lc23p3apolh04feq8q517sa';
const token = 'a1b2c3d4e5f6';
const configuration = createDomainConfiguration('https://codemaxxing.app', 'https://codemaxxing.net');

describe('configured hosting origins', () => {
	it('routes only the exact editor, git host, content apex and signed flat project hosts', () => {
		expect(classifyOrigin(configuration.appOrigin, configuration)).toEqual({ type: 'app' });
		expect(classifyOrigin(buildGitOrigin(configuration.appOrigin), configuration)).toEqual({ type: 'git' });
		expect(classifyOrigin(configuration.contentOrigin, configuration)).toEqual({ type: 'content' });
		const origin = buildPreviewOrigin(projectId, token, configuration.contentOrigin);
		expect(origin).toBe(`https://${projectId}-${token}.codemaxxing.net`);
		expect(classifyOrigin(origin, configuration)).toEqual({ type: 'preview', projectId, token });
	});

	it.each([
		'https://random.codemaxxing.app',
		'https://codemaxxing.app.attacker.net',
		'https://attacker.net',
		`https://${projectId}-${token}.preview.codemaxxing.app`,
		`https://${projectId}-${token}.nested.codemaxxing.net`,
		`https://${projectId}.codemaxxing.net`,
		`https://${projectId}-bad.codemaxxing.net`,
		`https://${projectId}-${token}.codemaxxing.net:444`,
		`http://${projectId}-${token}.codemaxxing.net`,
		'https://user:password@codemaxxing.app',
		'https://codemaxxing.app/path',
	])('rejects an unconfigured or malformed origin: %s', (origin) => {
		expect(classifyOrigin(origin, configuration)).toEqual({ type: 'unknown' });
	});

	it('uses the same HTTPS scheme and flat host structure locally', () => {
		const local = createDomainConfiguration('https://localhost:3000', 'https://content.localhost:3000');
		const origin = buildPreviewOrigin(projectId, token, local.contentOrigin);
		expect(origin).toBe(`https://${projectId}-${token}.content.localhost:3000`);
		expect(classifyOrigin(origin, local)).toEqual({ type: 'preview', projectId, token });
		expect(classifyOrigin('https://localhost:3001', local)).toEqual({ type: 'unknown' });
	});

	it('rejects ambiguous or insecure configuration', () => {
		expect(() => createDomainConfiguration('http://localhost:3000', configuration.contentOrigin)).toThrow();
		expect(() => createDomainConfiguration(configuration.appOrigin, configuration.appOrigin)).toThrow();
		expect(() => buildPreviewOrigin('../other', token, configuration.contentOrigin)).toThrow();
	});
});
