import { hc } from 'hono/client';
import { afterAll, describe, expect, it } from 'vitest';

import { BASE_URL, cleanupProjects, createdProjectIds, ensureTestSession, TEST_ORGANIZATION_ID } from './helpers';
import { throwApiError } from '../../src/lib/api-error';
import { localFetch } from '../local-https';

import type { ApiRoutes, RootApiRoutes } from '../../worker/routes';
import type { DevelopmentTestRoutes } from '../../worker/routes/development-test-routes';

describe('Worker-first project runtimes', () => {
	afterAll(cleanupProjects);
	it('renders vinext on Worker and stores the container preference without changing project files', async () => {
		const cookie = await ensureTestSession();
		const root = hc<RootApiRoutes>(`${BASE_URL}/api`, { fetch: localFetch, headers: { Cookie: cookie } });
		const created = await root['new-project'].$post({ json: { template: 'vinext', organizationId: TEST_ORGANIZATION_ID } });
		if (!created.ok) await throwApiError(created, 'Cannot create project');
		const { projectId } = await created.json();
		createdProjectIds.push(projectId);
		const api = hc<ApiRoutes>(`${BASE_URL}/p/${projectId}/api`, { fetch: localFetch, headers: { Cookie: cookie } });
		const manifest = await api.file.$get({ query: { path: '/package.json' } });
		const before = await manifest.json();
		const previewUrl = await api['preview-url'].$get({});
		const { url } = await previewUrl.json();
		const preview = await localFetch(url);
		expect(preview.status).toBe(200);
		expect(preview.headers.get('X-Worker-Ide-Runtime')).toBe('worker');
		expect(await preview.text()).toContain('Hello vinext');
		const runtime = hc<DevelopmentTestRoutes>(`${BASE_URL}/p/${projectId}/api`, { fetch: localFetch, headers: { Cookie: cookie } });
		const executionsResponse = await runtime.__test['computer-executions'].$get({ query: { sessionId: 'native-preview' } });
		expect(await executionsResponse.json()).toMatchObject({ executions: [] });
		const saved = await api.project.meta.$put({ json: { alwaysUseContainer: true } });
		expect(saved.ok).toBe(true);
		expect(await saved.json()).toMatchObject({ alwaysUseContainer: true });
		const reread = await api.file.$get({ query: { path: '/package.json' } });
		expect(await reread.json()).toEqual(before);
		const afterSaving = await runtime.__test['computer-executions'].$get({ query: { sessionId: 'native-preview' } });
		expect(await afterSaving.json()).toMatchObject({ executions: [] });
	});
});
