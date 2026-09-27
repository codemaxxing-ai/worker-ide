import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { WorkspaceClient } from './workspace-client';

describe('workspace client RPC results', () => {
	it('returns independent bytes and remapped metadata after disposing remote results', async () => {
		const stub = env.DurableObjectFilesystem.getByName('workspace-client-results');
		await stub.writeFiles([{ path: '/notes.txt', content: 'hello' }]);
		const client = new WorkspaceClient(stub);

		const bytes = await client.readFileBytes('/project/notes.txt');
		expect(new TextDecoder().decode(bytes)).toBe('hello');
		const fileStats = await client.stat('/project/notes.txt');
		const linkStats = await client.lstat('/project/notes.txt');
		const directoryEntries = await client.readDir('/project');
		const matchingEntries = await client.glob('/project/*.txt');
		expect(fileStats?.path).toBe('/project/notes.txt');
		expect(linkStats?.path).toBe('/project/notes.txt');
		expect(directoryEntries.map((entry) => entry.path)).toContain('/project/notes.txt');
		expect(matchingEntries.map((entry) => entry.path)).toContain('/project/notes.txt');
	});
});
