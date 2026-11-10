import { describe, expect, it } from 'vitest';

import { assertPreviewUrl } from './browser-tools';

describe('preview browser boundary', () => {
	const origins = ['https://project.preview.example'];
	it('resolves relative navigation inside the project and permits an empty new tab', () => {
		expect(assertPreviewUrl('/page?x=1', origins)).toBe('https://project.preview.example/page?x=1');
		expect(assertPreviewUrl('about:blank', origins)).toBe('about:blank');
	});
	it.each([
		'https://other.preview.example/',
		'https://project.preview.example.evil.test/',
		'https://project.preview.example:444/',
		'http://project.preview.example/',
		'file:///etc/passwd',
		'javascript:alert(1)',
	])('rejects navigation outside the allowed origin: %s', (url) => {
		expect(() => assertPreviewUrl(url, origins)).toThrow('project');
	});
});
