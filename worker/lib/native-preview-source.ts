import { Buffer } from 'node:buffer';

import { SNAPSHOT_EXCLUDED_DIRECTORIES } from '@shared/constants';

import type { ComputerWorkspace } from './computer-workspace';
import type { NativePreviewSourceEntry } from '@shared/native-preview';

/** Read the canonical SQLite tree while the mutation queue owns synchronization. */
export async function collectNativePreviewSource(
	workspace: Pick<ComputerWorkspace, 'readDir' | 'readFileBytes' | 'readlink'>,
): Promise<NativePreviewSourceEntry[]> {
	const entries: NativePreviewSourceEntry[] = [];
	const excluded = new Set([...SNAPSHOT_EXCLUDED_DIRECTORIES, '.cache', '.bun', '.next', 'coverage', 'tmp']);
	let totalBytes = 0;
	const visit = async (directory: string): Promise<void> => {
		for (const entry of await workspace.readDir(directory)) {
			if (excluded.has(entry.name) || (directory === '/' && ['wrangler.json', 'wrangler.jsonc', 'wrangler.toml'].includes(entry.name)))
				continue;
			const path = entry.path.slice(1);
			if (entry.type === 'directory') {
				entries.push({ path, type: 'directory' });
				await visit(entry.path);
				continue;
			}
			if (entry.type === 'symlink') {
				entries.push({ path, type: 'symlink', target: await workspace.readlink(entry.path) });
				continue;
			}
			const bytes = await workspace.readFileBytes(entry.path);
			if (!bytes) throw new Error(`Native preview source disappeared: ${entry.path}`);
			const contents = Buffer.from(bytes).toString('base64');
			totalBytes += contents.length + path.length;
			if (totalBytes > 12 * 1024 * 1024) throw new Error('Native source exceeds the 12 MiB transfer limit');
			entries.push({ path, type: 'file', contents });
		}
	};
	await visit('/');
	return entries;
}
