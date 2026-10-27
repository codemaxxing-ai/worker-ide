import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('managed starter typechecking', () => {
	it('checks source errors through root project references and succeeds after correction', () => {
		for (const template of ['minimal', 'request-inspector']) {
			const manifest = JSON.parse(readFileSync(new URL(`../worker/fixtures/${template}/package.json`, import.meta.url), 'utf8'));
			expect(manifest.scripts.typecheck).toBe('tsc -b');
		}
		const directory = mkdtempSync(path.join(tmpdir(), 'managed-typecheck-'));
		try {
			writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] }));
			writeFileSync(
				path.join(directory, 'tsconfig.app.json'),
				JSON.stringify({ compilerOptions: { noEmit: true, types: [] }, include: ['app.ts'] }),
			);
			const source = path.join(directory, 'app.ts');
			writeFileSync(source, 'export const value: number = "incorrect";');
			const argumentsValue = [createRequire(import.meta.url).resolve('typescript/lib/tsc.js'), '-b'];
			const failed = spawnSync(process.execPath, argumentsValue, { cwd: directory, encoding: 'utf8' });
			expect(failed.status).not.toBe(0);
			expect(failed.stdout).toContain('TS2322');
			writeFileSync(source, 'export const value: number = 1;');
			const corrected = spawnSync(process.execPath, argumentsValue, { cwd: directory, encoding: 'utf8' });
			expect(corrected.status, corrected.stdout + corrected.stderr).toBe(0);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 15_000);
});
