import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cloneProject, createProject, fetchTemplates } from './api-client';

const fetchMock = vi.fn<typeof globalThis.fetch>();

beforeEach(() => {
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.restoreAllMocks();
});
function jsonResponse(body: unknown, status = 200): Response {
	return Response.json(body, {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

describe('createProject', () => {
	it('creates a project with a template', async () => {
		const responseData = { projectId: 'abc123', url: '/p/abc123', name: 'gentle-wave' };
		fetchMock.mockResolvedValueOnce(jsonResponse(responseData));

		const result = await createProject('org1', 'request-inspector');

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/new-project',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({ template: 'request-inspector', organizationId: 'org1' }),
			}),
		);
		expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Content-Type')).toBe('application/json');
		expect(result).toEqual(responseData);
	});

	it('throws on non-OK response', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Bad request' }, 400));

		await expect(createProject('org1', 'request-inspector')).rejects.toThrow('Bad request');
	});

	it('throws on network error', async () => {
		fetchMock.mockRejectedValueOnce(new Error('Network error'));

		await expect(createProject('org1', 'request-inspector')).rejects.toThrow('Network error');
	});
});

describe('cloneProject', () => {
	const sourceId = '494rtk7ddoepe5ru2lx4oc855i6lc23p3apolh04feq8q517sa';

	it('clones a project successfully', async () => {
		const responseData = { projectId: 'new123', url: '/p/new123', name: 'cloned-project' };
		fetchMock.mockResolvedValueOnce(jsonResponse(responseData));

		const result = await cloneProject('org1', sourceId);

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/clone-project',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({ sourceProjectId: sourceId, organizationId: 'org1' }),
			}),
		);
		expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Content-Type')).toBe('application/json');
		expect(result).toEqual(responseData);
	});

	it('throws on 404', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Source project not found or not initialized' }, 404));

		await expect(cloneProject('org1', sourceId)).rejects.toThrow('Source project not found or not initialized');
	});

	it('throws on 400', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Invalid source project ID.' }, 400));

		await expect(cloneProject('org1', sourceId)).rejects.toThrow('Invalid source project ID');
	});

	it('throws on 500 with non-JSON body', async () => {
		fetchMock.mockResolvedValueOnce(new Response('not json', { status: 500 }));

		await expect(cloneProject('org1', sourceId)).rejects.toThrow('Failed to clone project');
	});

	it('throws on network error', async () => {
		fetchMock.mockRejectedValueOnce(new Error('Connection refused'));

		await expect(cloneProject('org1', sourceId)).rejects.toThrow('Connection refused');
	});
});

describe('fetchTemplates', () => {
	it('fetches templates successfully', async () => {
		const templatesData = [
			{
				id: 'request-inspector',
				name: 'Request Inspector',
				description: 'Inspect HTTP headers.',
				icon: 'Search',
			},
		];
		fetchMock.mockResolvedValueOnce(jsonResponse({ templates: templatesData }));

		const result = await fetchTemplates();

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock).toHaveBeenCalledWith('/api/templates', expect.objectContaining({ method: 'GET' }));
		expect(result).toEqual(templatesData);
	});

	it('throws on non-OK response', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Server error' }, 500));

		await expect(fetchTemplates()).rejects.toThrow('Server error');
	});

	it('throws on network error', async () => {
		fetchMock.mockRejectedValueOnce(new Error('Network error'));

		await expect(fetchTemplates()).rejects.toThrow('Network error');
	});
});
