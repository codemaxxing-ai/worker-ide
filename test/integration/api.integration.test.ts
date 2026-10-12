import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { localFetch as fetch } from '../local-https';
import { authedFetch, BASE_URL, cleanupProjects, createdProjectIds, ensureTestSession, TEST_ORGANIZATION_ID } from './helpers';
async function createTrackedProject(template = 'request-inspector'): Promise<{ projectId: string; url: string; name: string }> {
	const response = await authedFetch(`${BASE_URL}/api/new-project`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ template, organizationId: TEST_ORGANIZATION_ID }),
	});
	const result: { projectId: string; url: string; name: string } = await response.json();
	if (result.projectId) createdProjectIds.push(result.projectId);
	return result;
}

/**
 * Integration tests for REST API endpoints.
 * These test the HTTP API directly against a running dev server.
 */
describe('REST API Integration Tests', () => {
	beforeAll(async () => {
		await ensureTestSession();
		// Clean up leftover projects from prior interrupted runs
		await cleanupProjects();
	});

	afterAll(async () => {
		await cleanupProjects();
	});
	describe('Health & Availability', () => {
		it('should serve the app root', async () => {
			const response = await fetch(`${BASE_URL}/`);
			expect(response.ok).toBe(true);
		});
	});

	describe('Templates API', () => {
		it('GET /api/templates returns available templates', async () => {
			const response = await fetch(`${BASE_URL}/api/templates`);
			expect(response.ok).toBe(true);

			const result: { templates: Array<{ id: string; name: string; description: string }> } = await response.json();
			expect(Array.isArray(result.templates)).toBe(true);
			expect(result.templates.length).toBeGreaterThan(0);

			for (const template of result.templates) {
				expect(template).toHaveProperty('id');
				expect(template).toHaveProperty('name');
				expect(template).toHaveProperty('description');
			}
		});
	});

	describe('Project Creation API', () => {
		it('POST /api/new-project creates a new project', async () => {
			const result = await createTrackedProject();
			expect(result).toHaveProperty('projectId');
			expect(result).toHaveProperty('url');
			expect(result).toHaveProperty('name');

			expect(result.projectId).toMatch(/^[a-z\d]{1,50}$/);
			// url should contain the projectId
			expect(result.url).toBe(`/p/${result.projectId}`);
			// name should be a human-readable ID
			expect(result.name).toBeTruthy();
		});

		it('POST /api/new-project with template creates project with specified template', async () => {
			// First get available templates
			const templatesResponse = await fetch(`${BASE_URL}/api/templates`);
			const { templates }: { templates: Array<{ id: string }> } = await templatesResponse.json();
			const templateId = templates[0].id;

			const result = await createTrackedProject(templateId);
			expect(result.projectId).toMatch(/^[a-z\d]{1,50}$/);
		});

		it('POST /api/new-project initializes git status as clean immediately', async () => {
			const result = await createTrackedProject();
			const statusResponse = await authedFetch(`${BASE_URL}/p/${result.projectId}/api/git/status`);

			expect(statusResponse.ok).toBe(true);
			const status: { entries: unknown[]; initialized: boolean } = await statusResponse.json();
			expect(status.initialized).toBe(true);
			expect(status.entries).toEqual([]);
		});

		it('POST /api/new-project with invalid template returns 400', async () => {
			const response = await authedFetch(`${BASE_URL}/api/new-project`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ template: 'nonexistent-template-id', organizationId: TEST_ORGANIZATION_ID }),
			});

			expect(response.status).toBe(400);
			const result: { error: string } = await response.json();
			expect(result.error).toContain('Unknown template');
		});
	});

	describe('Project Clone API', () => {
		it('POST /api/clone-project clones an existing project', async () => {
			// Create a project first
			const { projectId: sourceProjectId } = await createTrackedProject();

			// Access the project to trigger initialization
			await authedFetch(`${BASE_URL}/p/${sourceProjectId}/api/files`);

			// Clone it
			const cloneResponse = await authedFetch(`${BASE_URL}/api/clone-project`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sourceProjectId, organizationId: TEST_ORGANIZATION_ID }),
			});

			expect(cloneResponse.ok).toBe(true);
			const result: { projectId: string; url: string; name: string } = await cloneResponse.json();
			if (result.projectId) createdProjectIds.push(result.projectId);
			expect(result.projectId).toMatch(/^[a-z\d]{1,50}$/);
			expect(result.projectId).not.toBe(sourceProjectId);
			expect(result.url).toBe(`/p/${result.projectId}`);
		});

		it('POST /api/clone-project with invalid sourceProjectId returns 400', async () => {
			const response = await authedFetch(`${BASE_URL}/api/clone-project`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sourceProjectId: 'not-a-valid-id' }),
			});

			expect(response.status).toBe(400);
		});

		it('POST /api/clone-project without body returns 400', async () => {
			const response = await authedFetch(`${BASE_URL}/api/clone-project`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			});

			expect(response.status).toBe(400);
		});
	});

	describe('Project File API', () => {
		let projectId: string;

		// Create a fresh project for file tests
		it('should create a project for file operations', async () => {
			const result = await createTrackedProject();
			projectId = result.projectId;
			expect(projectId).toBeTruthy();
		});

		it('GET /api/files returns the project file listing', async () => {
			const response = await authedFetch(`${BASE_URL}/p/${projectId}/api/files`);
			expect(response.ok).toBe(true);
			expect(response.headers.get('content-type')).toContain('application/json');

			const result: { files: Array<{ path: string; name: string; isDirectory: boolean }> } = await response.json();
			expect(Array.isArray(result.files)).toBe(true);
			expect(result.files.length).toBeGreaterThan(0);

			for (const file of result.files) {
				expect(file).toHaveProperty('path');
				expect(file).toHaveProperty('name');
				expect(file).toHaveProperty('isDirectory');
			}
		});

		it('repeated project API requests do not fall through to the app shell', async () => {
			for (let requestIndex = 0; requestIndex < 3; requestIndex++) {
				const response = await authedFetch(`${BASE_URL}/p/${projectId}/api/files`);
				expect(response.status).toBe(200);
				expect(response.headers.get('content-type')).toContain('application/json');

				const result: { files: unknown[] } = await response.json();
				expect(Array.isArray(result.files)).toBe(true);
			}
		});

		it('GET /api/file?path= returns file content', async () => {
			// Read the index.html which should exist from the template
			const response = await authedFetch(`${BASE_URL}/p/${projectId}/api/file?path=/index.html`);
			expect(response.ok).toBe(true);

			const result: { path: string; content: string } = await response.json();
			expect(typeof result.content).toBe('string');
			expect(result.content.length).toBeGreaterThan(0);
			expect(result.path).toBe('/index.html');
		});

		it('PUT /api/file creates or updates a file', async () => {
			const testContent = '// integration test file\nconsole.log("hello");\n';
			const response = await authedFetch(`${BASE_URL}/p/${projectId}/api/file`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: '/test-file.js', content: testContent }),
			});

			expect(response.ok).toBe(true);

			// Verify the file was written
			const readResponse = await authedFetch(`${BASE_URL}/p/${projectId}/api/file?path=/test-file.js`);
			const readResult: { content: string } = await readResponse.json();
			expect(readResult.content).toBe(testContent);
		});

		it('DELETE /api/file?path= deletes a file', async () => {
			// Create a file to delete
			await authedFetch(`${BASE_URL}/p/${projectId}/api/file`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: '/to-delete.txt', content: 'delete me' }),
			});

			const deleteResponse = await authedFetch(`${BASE_URL}/p/${projectId}/api/file?path=/to-delete.txt`, {
				method: 'DELETE',
			});

			expect(deleteResponse.ok).toBe(true);

			// Verify the file is gone
			const readResponse = await authedFetch(`${BASE_URL}/p/${projectId}/api/file?path=/to-delete.txt`);
			expect(readResponse.ok).toBe(false);
		});

		it('favorite and unfavorite a project', async () => {
			const result = await createTrackedProject();
			const projectIdForFavoriteTest = result.projectId;

			// Access any project-scoped API route so the gateway records user access
			const accessResponse = await authedFetch(`${BASE_URL}/p/${projectIdForFavoriteTest}/api/project/meta`);
			expect(accessResponse.ok).toBe(true);

			// Favorite
			const favoriteResponse = await authedFetch(`${BASE_URL}/api/user/project/${projectIdForFavoriteTest}/favorite`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ favorite: true }),
			});
			expect(favoriteResponse.ok).toBe(true);
			const favoriteResult: { projectId: string; favorite: boolean } = await favoriteResponse.json();
			expect(favoriteResult.favorite).toBe(true);

			// Verify the favorite shows up on recent-projects
			const recentResponse = await authedFetch(`${BASE_URL}/api/user/recent-projects`);
			expect(recentResponse.ok).toBe(true);
			const recentProjects: { projects: Array<{ id: string; isFavorite: boolean }> } = await recentResponse.json();
			const recentProject = recentProjects.projects.find((project) => project.id === projectIdForFavoriteTest);
			expect(recentProject).toBeDefined();
			expect(recentProject?.isFavorite).toBe(true);

			// Unfavorite
			const unfavoriteResponse = await authedFetch(`${BASE_URL}/api/user/project/${projectIdForFavoriteTest}/favorite`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ favorite: false }),
			});
			expect(unfavoriteResponse.ok).toBe(true);
			const unfavoriteResult: { projectId: string; favorite: boolean } = await unfavoriteResponse.json();
			expect(unfavoriteResult.favorite).toBe(false);

			// Verify unfavorited in recent-projects
			const recentAfterResponse = await authedFetch(`${BASE_URL}/api/user/recent-projects`);
			expect(recentAfterResponse.ok).toBe(true);
			const recentAfter: { projects: Array<{ id: string; isFavorite: boolean }> } = await recentAfterResponse.json();
			const recentAfterProject = recentAfter.projects.find((project) => project.id === projectIdForFavoriteTest);
			expect(recentAfterProject).toBeDefined();
			expect(recentAfterProject?.isFavorite).toBe(false);
		});
	});
});
