import { hc } from 'hono/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BASE_URL, cleanupProjects, createdProjectIds, ensureTestSession, TEST_ORGANIZATION_ID } from './helpers';
import { throwApiError } from '../../src/lib/api-error';

import type { ApiRoutes, RootApiRoutes } from '../../worker/routes';
import type { DevelopmentTestRoutes } from '../../worker/routes/development-test-routes';

describe('Computer live runtime', () => {
	let projectId: string;
	let cookie: string;
	beforeAll(async () => {
		cookie = await ensureTestSession();
		const root = hc<RootApiRoutes>(`${BASE_URL}/api`, { headers: { Cookie: cookie } });
		const response = await root['new-project'].$post({ json: { template: 'request-inspector', organizationId: TEST_ORGANIZATION_ID } });
		if (!response.ok) throw new Error(`Cannot create Computer integration project: ${response.status}`);
		const created = await response.json();
		projectId = created.projectId;
		createdProjectIds.push(projectId);
		const api = hc<ApiRoutes>(`${BASE_URL}/p/${projectId}/api`, { headers: { Cookie: cookie } });
		await api.files.$get({});
	});
	afterAll(cleanupProjects);

	it('shares editor changes with shell execution and rejects the command snapshot', async () => {
		const api = hc<ApiRoutes>(`${BASE_URL}/p/${projectId}/api`, { headers: { Cookie: cookie } });
		const runtime = hc<DevelopmentTestRoutes>(`${BASE_URL}/p/${projectId}/api`, { headers: { Cookie: cookie } });
		const edit = await api.file.$put({ json: { path: '/computer.txt', content: 'editor baseline' } });
		expect(edit.ok).toBe(true);
		const response = await runtime.__test['computer-exec'].$post({
			json: { command: 'cat computer.txt; printf "command change" > computer.txt', snapshot: true },
		});
		if (!response.ok) throw new Error(`Shell execution failed: ${response.status}`);
		const data = await response.json();
		expect(data.result).toMatchObject({ exitCode: 0, stdout: 'editor baseline', syncStatus: 'complete' });
		expect(data.changes).toContainEqual(
			expect.objectContaining({ path: '/computer.txt', beforeContent: 'editor baseline', afterContent: 'command change' }),
		);
		if (!data.snapshotId) throw new Error('Missing command snapshot');
		const reverted = await api.snapshot[':id'].revert.$post({ param: { id: data.snapshotId } });
		expect(reverted.ok).toBe(true);
		const file = await api.file.$get({ query: { path: '/computer.txt' } });
		if (!file.ok) throw new Error('Restored file missing');
		const restored = await file.json();
		expect(restored.content).toBe('editor baseline');
	});

	it('runs local Git through the isolate shell against the existing project repository', async () => {
		const runtime = hc<DevelopmentTestRoutes>(`${BASE_URL}/p/${projectId}/api`, { headers: { Cookie: cookie } });
		const response = await runtime.__test['computer-exec'].$post({
			json: { command: 'git status --short; git -C /project diff -- computer.txt' },
		});
		if (!response.ok) throw new Error(`Shell Git execution failed: ${response.status}`);
		const data = await response.json();
		expect(data.result.exitCode, data.result.stderr).toBe(0);
		expect(data.result.stdout).toContain('computer.txt');
	});

	it('installs packages, runs native tools and synchronizes bytes and symlinks in both directions', async () => {
		const api = hc<ApiRoutes>(`${BASE_URL}/p/${projectId}/api`, { headers: { Cookie: cookie } });
		const runtime = hc<DevelopmentTestRoutes>(`${BASE_URL}/p/${projectId}/api`, { headers: { Cookie: cookie } });
		await api.file.$put({ json: { path: '/native/input.txt', content: 'from editor' } });
		const response = await runtime.__test['computer-exec'].$post({
			json: {
				backend: 'container',
				command:
					'set -e; node --version; bun --version; git --version; python3 --version; mkdir -p native/install; cd native/install; printf \'{"name":"computer-check","private":true,"dependencies":{"is-number":"7.0.0"}}\' > package.json; bun install; node -e "if (!require(\'is-number\')(42)) process.exit(1)"; cd /workspace; python3 -c "from pathlib import Path; assert Path(\'native/input.txt\').read_text() == \'from editor\'; Path(\'native/output.txt\').write_text(\'from container\'); Path(\'native/output.bin\').write_bytes(bytes([0,255,128,42]))"; ln -s input.txt native/link',
				snapshot: true,
			},
		});
		if (!response.ok) await throwApiError(response, `Native execution failed: ${response.status}`);
		const data = await response.json();
		expect(data.result.exitCode, `${data.result.stdout}\n${data.result.stderr}`).toBe(0);
		expect(data.result).toMatchObject({ syncStatus: 'complete', backend: 'container' });
		expect(data.result.stdout).toContain('v24.');
		expect(data.result.stdout).toContain('1.3.14');
		expect(data.changes.some((change) => change.path.includes('node_modules'))).toBe(false);
		expect(data.changes).toContainEqual(expect.objectContaining({ path: '/native/output.bin', isBinary: true, afterBytes: 'AP+AKg==' }));
		expect(data.changes).toContainEqual(expect.objectContaining({ path: '/native/link', entryType: 'symlink', afterContent: 'input.txt' }));
		const file = await api.file.$get({ query: { path: '/native/output.txt' } });
		if (!file.ok) throw new Error('Container output did not synchronize');
		const synchronized = await file.json();
		expect(synchronized.content).toBe('from container');
	});
	it('orders two sessions and an editor save through container synchronization, without replaying a completed ID', async () => {
		const api = hc<ApiRoutes>(`${BASE_URL}/p/${projectId}/api`, { headers: { Cookie: cookie } });
		const runtime = hc<DevelopmentTestRoutes>(`${BASE_URL}/p/${projectId}/api`, { headers: { Cookie: cookie } });
		await api.file.$put({ json: { path: '/ordered.txt', content: 'baseline' } });
		const id = crypto.randomUUID();
		const first = runtime.__test['computer-exec'].$post({
			json: { id, backend: 'container', sessionId: 'first', command: 'sleep 2; printf first > ordered.txt' },
		});
		await expect
			.poll(async () => {
				const response = await runtime.__test['computer-executions'].$get({ query: { sessionId: 'first' } });
				const data = await response.json();
				return data.executions.find((execution) => execution.id === id)?.status;
			})
			.toBe('running');
		const second = runtime.__test['computer-exec'].$post({
			json: { sessionId: 'second', command: 'cat ordered.txt; printf second > ordered.txt' },
		});
		// Send the editor save after the second session has entered the FIFO.
		await new Promise((resolve) => setTimeout(resolve, 100));
		const editor = api.file.$put({ json: { path: '/ordered.txt', content: 'editor' } });
		const responses = await Promise.all([first, second, editor]);
		for (const response of responses) expect(response.ok).toBe(true);
		const firstData = await responses[0].json();
		const secondData = await responses[1].json();
		expect(firstData.changes).toContainEqual(
			expect.objectContaining({ path: '/ordered.txt', beforeContent: 'baseline', afterContent: 'first' }),
		);
		expect(secondData.result.stdout).toBe('first');
		expect(secondData.changes).toContainEqual(
			expect.objectContaining({ path: '/ordered.txt', beforeContent: 'first', afterContent: 'second' }),
		);
		const replayed = await runtime.__test['computer-exec'].$post({
			json: { id, backend: 'container', sessionId: 'first', command: 'printf unsafe-replay > ordered.txt' },
		});
		const cached = await replayed.json();
		expect(cached.result).toEqual(firstData.result);
		const file = await api.file.$get({ query: { path: '/ordered.txt' } });
		const saved = await file.json();
		expect(saved.content).toBe('editor');
	});

	it('cancels native descendants, synchronizes partial writes and releases queued editor saves', async () => {
		const api = hc<ApiRoutes>(`${BASE_URL}/p/${projectId}/api`, { headers: { Cookie: cookie } });
		const runtime = hc<DevelopmentTestRoutes>(`${BASE_URL}/p/${projectId}/api`, { headers: { Cookie: cookie } });
		const id = crypto.randomUUID();
		const running = runtime.__test['computer-exec'].$post({
			json: {
				id,
				backend: 'container',
				sessionId: 'cancel',
				command: 'printf partial > cancelled.txt; (sleep 5; printf escaped > escaped.txt) & sleep 20',
			},
		});
		await expect
			.poll(async () => {
				const response = await runtime.__test['computer-executions'].$get({ query: { sessionId: 'cancel' } });
				const data = await response.json();
				return data.executions.find((execution) => execution.id === id)?.status;
			})
			.toBe('running');
		const queued = api.file.$put({ json: { path: '/cancelled.txt', content: 'editor after Stop' } });
		const cancelled = await runtime.__test['computer-cancel'].$post({ json: { id, sessionId: 'cancel' } });
		expect(cancelled.ok).toBe(true);
		const completed = await running;
		const data = await completed.json();
		expect(data.result).toMatchObject({ status: 'cancelled', syncStatus: 'complete' });
		const saved = await queued;
		expect(saved.ok).toBe(true);
		const verify = await runtime.__test['computer-exec'].$post({
			json: { backend: 'container', command: 'sleep 6; test ! -e escaped.txt; cat cancelled.txt' },
		});
		const verified = await verify.json();
		expect(verified.result).toMatchObject({ exitCode: 0, stdout: 'editor after Stop', syncStatus: 'complete' });
	});
});
