import { hc } from 'hono/client';
import { afterAll, describe, expect, it } from 'vitest';

import { BASE_URL, cleanupProjects, createdProjectIds, ensureTestSession, TEST_ORGANIZATION_ID } from './helpers';
import { throwApiError } from '../../src/lib/api-error';

import type { ApiRoutes, RootApiRoutes } from '../../worker/routes';
import type { DevelopmentTestRoutes } from '../../worker/routes/development-test-routes';

describe('native Vite production builds', () => {
	afterAll(cleanupProjects);
	it('builds a vinext Worker module and client assets in the project container', async () => {
		const cookie = await ensureTestSession();
		const root = hc<RootApiRoutes>(`${BASE_URL}/api`, { headers: { Cookie: cookie } });
		const createdResponse = await root['new-project'].$post({ json: { template: 'vinext', organizationId: TEST_ORGANIZATION_ID } });
		if (!createdResponse.ok) await throwApiError(createdResponse, 'Cannot create native build project');
		const { projectId } = await createdResponse.json();
		createdProjectIds.push(projectId);
		const runtime = hc<DevelopmentTestRoutes>(`${BASE_URL}/p/${projectId}/api`, { headers: { Cookie: cookie } });
		const response = await runtime.__test['native-build'].$post({});
		if (!response.ok) await throwApiError(response, 'Native build failed');
		const artifact = await response.json();
		expect(artifact.mainModule).toBe('index.js');
		expect(artifact.renderedStatus).toBe(200);
		expect(artifact.renderedHtml).toContain('Hello vinext');
		expect(Object.keys(artifact.clientFiles).some((filename) => filename.endsWith('.js'))).toBe(true);
		expect(Object.keys(artifact.clientFiles).some((filename) => filename.endsWith('.css'))).toBe(true);
		const executionsResponse = await runtime.__test['computer-executions'].$get({ query: { sessionId: 'native-build' } });
		const { executions } = await executionsResponse.json();
		expect(executions).toHaveLength(1);
		expect(executions[0]).toMatchObject({ backend: 'container', status: 'completed', result: { exitCode: 0, syncStatus: 'complete' } });
	});
	it('executes a custom Vite plugin when building a static React site', async () => {
		const cookie = await ensureTestSession();
		const root = hc<RootApiRoutes>(`${BASE_URL}/api`, { headers: { Cookie: cookie } });
		const createdResponse = await root['new-project'].$post({ json: { template: 'minimal', organizationId: TEST_ORGANIZATION_ID } });
		if (!createdResponse.ok) await throwApiError(createdResponse, 'Cannot create static build project');
		const { projectId } = await createdResponse.json();
		createdProjectIds.push(projectId);
		const api = hc<ApiRoutes>(`${BASE_URL}/p/${projectId}/api`, { headers: { Cookie: cookie } });
		await api.files.$get({});
		const runtime = hc<DevelopmentTestRoutes>(`${BASE_URL}/p/${projectId}/api`, { headers: { Cookie: cookie } });
		const saved = await runtime.__test['computer-exec'].$post({
			json: {
				command: `cat > vite.config.ts <<'CONFIGURATION'\nimport react from '@vitejs/plugin-react'; import { defineConfig } from 'vite'; export default defineConfig({ plugins: [react(), { name: 'custom-html', transformIndexHtml(html) { return html.replace('</head>', '<meta name="native-plugin" content="executed"></head>'); } }] });\nCONFIGURATION`,
			},
		});
		if (!saved.ok) await throwApiError(saved, 'Cannot save custom Vite configuration');
		const savedConfiguration = await saved.json();
		expect(savedConfiguration.result.exitCode).toBe(0);
		const response = await runtime.__test['native-build'].$post({});
		if (!response.ok) await throwApiError(response, 'Static native build failed');
		const artifact = await response.json();
		expect(Buffer.from(artifact.clientFiles['index.html'], 'base64').toString()).toContain(
			'<meta name="native-plugin" content="executed">',
		);
		expect(artifact.serverModules).toBeUndefined();
		expect(Object.keys(artifact.clientFiles).some((filename) => filename.endsWith('.js'))).toBe(true);
	});
});
