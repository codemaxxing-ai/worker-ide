import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';

import { isValidProjectId } from '../../shared/project-id';

import type { BrowserContext } from 'playwright/test';

const frontendDirectory = new URL('../../dist/client/', import.meta.url);

/** Test the shipped editor against the live Worker, including its response policy. */
export async function serveBuiltEditor(context: BrowserContext): Promise<void> {
	const editorOrigin = new URL(process.env.TEST_BASE_URL || 'https://localhost:3000').origin;
	await context.route(`${editorOrigin}/**`, async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const isProjectDocument =
			request.resourceType() === 'document' && url.pathname.startsWith('/p/') && isValidProjectId(url.pathname.slice(3));
		const isAsset = url.pathname.startsWith('/assets/');
		if (!isProjectDocument && !isAsset) return route.continue();
		const response = await route.fetch();
		if (!response.ok() && !(isAsset && response.status() === 404)) return route.fulfill({ response });
		const headers = response.headers();
		delete headers['content-length'];
		delete headers['content-encoding'];
		const filename = isProjectDocument ? 'index.html' : url.pathname.slice(1);
		headers['content-type'] = isProjectDocument ? 'text/html' : filename.endsWith('.css') ? 'text/css' : 'application/javascript';
		await route.fulfill({ response, status: 200, headers, body: await readFile(new URL(filename, frontendDirectory)) });
	});
}
