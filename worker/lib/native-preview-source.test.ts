import { describe, expect, it } from 'vitest';

import { collectNativePreviewSource } from './native-preview-source';

import type { FileInfo } from '@shared/types';

function entry(path: string, type: FileInfo['type']): FileInfo {
	return { path, type, name: path.split('/').at(-1) ?? '', mimeType: 'application/octet-stream', size: 3, createdAt: 0, updatedAt: 0 };
}

describe('canonical native preview source', () => {
	it('preserves binary bytes and symlinks while pruning runtime and IDE files', async () => {
		const visited: string[] = [];
		const source = await collectNativePreviewSource({
			async readDir(path) {
				visited.push(path);
				return path === '/'
					? [entry('/app', 'directory'), entry('/.git', 'directory'), entry('/node_modules', 'directory'), entry('/wrangler.jsonc', 'file')]
					: [entry('/app/asset.bin', 'file'), entry('/app/link', 'symlink')];
			},
			async readFileBytes() {
				return new Uint8Array([0, 255, 128]);
			},
			async readlink() {
				return 'asset.bin';
			},
		});
		expect(visited).toEqual(['/', '/app']);
		expect(source).toEqual([
			{ path: 'app', type: 'directory' },
			{ path: 'app/asset.bin', type: 'file', contents: 'AP+A' },
			{ path: 'app/link', type: 'symlink', target: 'asset.bin' },
		]);
	});
	it('rejects a source transfer larger than its bounded request budget', async () => {
		await expect(
			collectNativePreviewSource({
				async readDir() {
					return [entry('/source.ts', 'file')];
				},
				async readFileBytes() {
					return new Uint8Array(10 * 1024 * 1024);
				},
				async readlink() {
					return '';
				},
			}),
		).rejects.toThrow('Native source exceeds the 12 MiB transfer limit');
	});
});
