import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import {
	deployRoutes,
	extractFrontendEntryPoint,
	generateProductionHtml,
	hashFileForManifest,
	isConfigFile,
	isSourceFile,
	sanitizeR2BucketName,
	sanitizeWorkerName,
} from './deploy-routes';

describe('deployment status', () => {
	it('reports workflow rollback as running for deployment clients', async () => {
		const instanceId = crypto.randomUUID();
		const workflowInstance: WorkflowInstance = {
			id: instanceId,
			status: vi.fn<WorkflowInstance['status']>().mockResolvedValue({ status: 'rollingBack' }),
			pause: vi.fn<WorkflowInstance['pause']>(),
			resume: vi.fn<WorkflowInstance['resume']>(),
			terminate: vi.fn<WorkflowInstance['terminate']>(),
			restart: vi.fn<WorkflowInstance['restart']>(),
			delete: vi.fn<WorkflowInstance['delete']>(),
			sendEvent: vi.fn<WorkflowInstance['sendEvent']>(),
			subscribe: vi.fn<WorkflowInstance['subscribe']>(),
		};
		const getInstance = vi.spyOn(env.DEPLOY_WORKFLOW, 'get').mockResolvedValue(workflowInstance);

		try {
			const response = await deployRoutes.request(`https://example.com/deploy/status?instanceId=${instanceId}`, {}, env);

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ instanceId, status: 'running' });
		} finally {
			getInstance.mockRestore();
		}
	});
});

describe('sanitizeWorkerName', () => {
	it('lowercases uppercase characters', () => {
		expect(sanitizeWorkerName('MyWorker')).toBe('myworker');
	});

	it('replaces non-alphanumeric characters with hyphens', () => {
		expect(sanitizeWorkerName('my worker app')).toBe('my-worker-app');
	});

	it('collapses multiple hyphens into one', () => {
		expect(sanitizeWorkerName('my---worker')).toBe('my-worker');
	});

	it('strips leading and trailing hyphens', () => {
		expect(sanitizeWorkerName('-my-worker-')).toBe('my-worker');
	});

	it('handles special characters', () => {
		expect(sanitizeWorkerName('my_worker@v2')).toBe('my-worker-v2');
	});

	it('truncates to 63 characters', () => {
		const longName = 'a'.repeat(100);
		expect(sanitizeWorkerName(longName)).toHaveLength(63);
	});

	it('returns my-worker for empty string', () => {
		expect(sanitizeWorkerName('')).toBe('my-worker');
	});

	it('returns my-worker for string of only special characters', () => {
		expect(sanitizeWorkerName('!!!')).toBe('my-worker');
	});

	it('preserves valid names unchanged', () => {
		expect(sanitizeWorkerName('my-worker-123')).toBe('my-worker-123');
	});
});

describe('sanitizeR2BucketName', () => {
	it('appends a deterministic -storage hash suffix to worker name', () => {
		expect(sanitizeR2BucketName('my-worker')).toMatch(/^my-worker-storage-[\da-f]{8}$/);
	});

	it('lowercases and sanitizes the name', () => {
		expect(sanitizeR2BucketName('My Worker')).toMatch(/^my-worker-storage-[\da-f]{8}$/);
	});

	it('handles special characters', () => {
		expect(sanitizeR2BucketName('my_worker@v2')).toMatch(/^my-worker-v2-storage-[\da-f]{8}$/);
	});

	it('truncates long names to fit within 63 chars', () => {
		const longName = 'a'.repeat(100);
		const result = sanitizeR2BucketName(longName);
		expect(result.length).toBeLessThanOrEqual(63);
		expect(result).toMatch(/-storage-[\da-f]{8}$/);
	});

	it('returns a valid app fallback for empty input', () => {
		expect(sanitizeR2BucketName('')).toMatch(/^app-storage-[\da-f]{8}$/);
	});

	it('returns a valid app fallback for only special characters', () => {
		expect(sanitizeR2BucketName('!!!')).toMatch(/^app-storage-[\da-f]{8}$/);
	});

	it('produces names with minimum 3 characters', () => {
		const result = sanitizeR2BucketName('a');
		expect(result.length).toBeGreaterThanOrEqual(3);
	});

	it('does not produce leading or trailing hyphens', () => {
		const result = sanitizeR2BucketName('-test-');
		expect(result).not.toMatch(/^-/);
		expect(result).not.toMatch(/-$/);
	});

	it('preserves leading digits when they are part of a valid bucket name', () => {
		expect(sanitizeR2BucketName('123-my-app')).toMatch(/^123-my-app-storage-[\da-f]{8}$/);
	});

	it('preserves digit-only names when they are valid bucket names', () => {
		expect(sanitizeR2BucketName('12345')).toMatch(/^12345-storage-[\da-f]{8}$/);
	});

	it('avoids collisions for names that previously normalized to the same bucket', () => {
		expect(sanitizeR2BucketName('123-my-app')).not.toBe(sanitizeR2BucketName('my-app'));
	});

	it('avoids collisions for long names that share the same truncated prefix', () => {
		const first = sanitizeR2BucketName(`${'a'.repeat(80)}-one`);
		const second = sanitizeR2BucketName(`${'a'.repeat(80)}-two`);
		expect(first).not.toBe(second);
	});
});

describe('extractFrontendEntryPoint', () => {
	it('extracts src path from script type=module tag', () => {
		const html = '<html><body><script type="module" src="/src/main.tsx"></script></body></html>';
		expect(extractFrontendEntryPoint(html)).toBe('src/main.tsx');
	});

	it('extracts src path from plain script tag', () => {
		const html = '<html><body><script src="src/app.js"></script></body></html>';
		expect(extractFrontendEntryPoint(html)).toBe('src/app.js');
	});

	it('strips leading slash from src path', () => {
		const html = '<script type="module" src="/src/main.tsx"></script>';
		expect(extractFrontendEntryPoint(html)).toBe('src/main.tsx');
	});

	it('skips external scripts (https)', () => {
		const html = `
			<script src="https://cdn.example.com/lib.js"></script>
			<script type="module" src="/src/main.tsx"></script>
		`;
		expect(extractFrontendEntryPoint(html)).toBe('src/main.tsx');
	});

	it('skips external scripts (http)', () => {
		const html = `
			<script src="http://cdn.example.com/lib.js"></script>
			<script type="module" src="/src/main.tsx"></script>
		`;
		expect(extractFrontendEntryPoint(html)).toBe('src/main.tsx');
	});

	it('skips internal preview scripts starting with __', () => {
		const html = `
			<script type="module" src="__preview/client.js"></script>
			<script type="module" src="/src/main.tsx"></script>
		`;
		expect(extractFrontendEntryPoint(html)).toBe('src/main.tsx');
	});

	it('returns undefined when no script tags exist', () => {
		const html = '<html><body><p>Hello</p></body></html>';
		expect(extractFrontendEntryPoint(html)).toBeUndefined();
	});

	it('returns undefined when only external scripts exist', () => {
		const html = '<script src="https://cdn.example.com/lib.js"></script>';
		expect(extractFrontendEntryPoint(html)).toBeUndefined();
	});

	it('handles single-quoted src attributes', () => {
		const html = "<script type='module' src='/src/main.tsx'></script>";
		expect(extractFrontendEntryPoint(html)).toBe('src/main.tsx');
	});
});

describe('isSourceFile', () => {
	it('returns true for .ts files', () => {
		expect(isSourceFile('src/utils.ts')).toBe(true);
	});

	it('returns true for .tsx files', () => {
		expect(isSourceFile('src/app.tsx')).toBe(true);
	});

	it('returns true for .jsx files', () => {
		expect(isSourceFile('components/button.jsx')).toBe(true);
	});

	it('returns true for .mts files', () => {
		expect(isSourceFile('worker/index.mts')).toBe(true);
	});

	it('returns true for .mjs files', () => {
		expect(isSourceFile('worker/index.mjs')).toBe(true);
	});

	it('returns true for .js files under src/', () => {
		expect(isSourceFile('src/main.js')).toBe(true);
	});

	it('returns false for .js files outside src/', () => {
		expect(isSourceFile('public/script.js')).toBe(false);
	});

	it('returns false for .css files', () => {
		expect(isSourceFile('src/style.css')).toBe(false);
	});

	it('returns false for .html files', () => {
		expect(isSourceFile('index.html')).toBe(false);
	});

	it('returns false for .json files', () => {
		expect(isSourceFile('package.json')).toBe(false);
	});

	it('returns false for image files', () => {
		expect(isSourceFile('public/logo.png')).toBe(false);
	});
});

describe('generateProductionHtml', () => {
	it('replaces the original entry path with the bundled path', () => {
		const html = '<html><body><script type="module" src="/src/main.tsx"></script></body></html>';
		const result = generateProductionHtml(html, 'src/main.tsx', '/assets/bundle-abc12345.js');
		expect(result).toBe('<html><body><script type="module" src="/assets/bundle-abc12345.js"></script></body></html>');
	});

	it('handles entry path with leading slash', () => {
		const html = '<script type="module" src="/src/main.tsx"></script>';
		const result = generateProductionHtml(html, 'src/main.tsx', '/assets/bundle.js');
		expect(result).toBe('<script type="module" src="/assets/bundle.js"></script>');
	});

	it('handles entry path without leading slash in HTML', () => {
		const html = '<script type="module" src="src/main.tsx"></script>';
		const result = generateProductionHtml(html, 'src/main.tsx', '/assets/bundle.js');
		expect(result).toBe('<script type="module" src="/assets/bundle.js"></script>');
	});

	it('preserves other HTML content', () => {
		const html = `<!DOCTYPE html>
<html>
<head><title>App</title></head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>`;
		const result = generateProductionHtml(html, 'src/main.tsx', '/assets/bundle-abc.js');
		expect(result).toContain('<title>App</title>');
		expect(result).toContain('<div id="root"></div>');
		expect(result).toContain('src="/assets/bundle-abc.js"');
		expect(result).not.toContain('src/main.tsx');
	});

	it('does not modify unrelated script tags', () => {
		const html = `
<script src="https://cdn.example.com/lib.js"></script>
<script type="module" src="/src/main.tsx"></script>`;
		const result = generateProductionHtml(html, 'src/main.tsx', '/assets/bundle.js');
		expect(result).toContain('src="https://cdn.example.com/lib.js"');
		expect(result).toContain('src="/assets/bundle.js"');
	});
});

describe('hashFileForManifest', () => {
	it('returns a 32-character hex string', async () => {
		const content = new TextEncoder().encode('hello world');
		const hash = await hashFileForManifest(content, '/index.html');
		expect(hash).toMatch(/^[\da-f]{32}$/);
	});

	it('is deterministic for same content and path', async () => {
		const content = new TextEncoder().encode('test content');
		const hash1 = await hashFileForManifest(content, '/app.js');
		const hash2 = await hashFileForManifest(content, '/app.js');
		expect(hash1).toBe(hash2);
	});

	it('produces different hashes for different content', async () => {
		const content1 = new TextEncoder().encode('file one');
		const content2 = new TextEncoder().encode('file two');
		const hash1 = await hashFileForManifest(content1, '/app.js');
		const hash2 = await hashFileForManifest(content2, '/app.js');
		expect(hash1).not.toBe(hash2);
	});

	it('produces different hashes for different file extensions', async () => {
		const content = new TextEncoder().encode('same content');
		const hashHtml = await hashFileForManifest(content, '/index.html');
		const hashJs = await hashFileForManifest(content, '/index.js');
		expect(hashHtml).not.toBe(hashJs);
	});

	it('handles empty content', async () => {
		const content = new Uint8Array(0);
		const hash = await hashFileForManifest(content, '/empty.txt');
		expect(hash).toMatch(/^[\da-f]{32}$/);
	});

	it('handles files without extension', async () => {
		const content = new TextEncoder().encode('no ext');
		const hash = await hashFileForManifest(content, '/Dockerfile');
		expect(hash).toMatch(/^[\da-f]{32}$/);
	});

	it('produces different hashes for same content and extension but different paths', async () => {
		const content = new TextEncoder().encode('same content');
		const hash1 = await hashFileForManifest(content, '/assets/a.js');
		const hash2 = await hashFileForManifest(content, '/assets/b.js');
		expect(hash1).not.toBe(hash2);
	});
});

describe('isConfigFile', () => {
	it('returns true for package.json', () => {
		expect(isConfigFile('package.json')).toBe(true);
	});

	it('returns true for tsconfig.json', () => {
		expect(isConfigFile('tsconfig.json')).toBe(true);
	});

	it('returns true for tsconfig.app.json', () => {
		expect(isConfigFile('tsconfig.app.json')).toBe(true);
	});

	it('returns true for tsconfig.worker.json', () => {
		expect(isConfigFile('tsconfig.worker.json')).toBe(true);
	});

	it('returns true for .gitignore', () => {
		expect(isConfigFile('.gitignore')).toBe(true);
	});

	it('returns false for CSS files', () => {
		expect(isConfigFile('style.css')).toBe(false);
	});

	it('returns false for image files', () => {
		expect(isConfigFile('logo.png')).toBe(false);
	});

	it('returns false for nested config-like files', () => {
		expect(isConfigFile('src/package.json')).toBe(false);
	});
});
