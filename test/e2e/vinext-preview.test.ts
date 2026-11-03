import { hc } from 'hono/client';

import { waitForFileTree } from './helpers';
import { expect, test } from './test-fixtures';
import { localFetch } from '../local-https';

import type { ApiRoutes } from '../../worker/routes';
import type { Page } from 'playwright/test';

/** Read a project file, apply a replacement, and save it back through the API. */
async function editProjectFile(page: Page, projectId: string, path: string, find: string, replace: string): Promise<void> {
	const cookies = await page.context().cookies(page.url());
	const api = hc<ApiRoutes>(`${new URL(page.url()).origin}/p/${projectId}/api`, {
		fetch: localFetch,
		headers: { Cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ') },
	});
	const read = await api.file.$get({ query: { path } });
	if (!read.ok) throw new Error(`Failed to load ${path}: ${read.status}`);
	const data = await read.json();
	if (!data.content.includes(find)) throw new Error(`Expected ${path} to contain ${JSON.stringify(find)}`);
	const response = await api.file.$put({ json: { path, content: data.content.replace(find, replace) } });
	if (!response.ok) throw new Error(`Failed to save ${path}: ${response.status}`);
}

for (const runtime of ['Worker', 'Container']) {
	test.describe(`vinext ${runtime} preview + HMR`, () => {
		const observedWebsocketPaths = new WeakMap<Page, string[]>();
		test.beforeEach(({ page }) => {
			const paths: string[] = [];
			observedWebsocketPaths.set(page, paths);
			page.on('websocket', (socket) => paths.push(new URL(socket.url()).pathname));
		});
		test.use({ nativeProjectOptions: { template: 'vinext', warmPreview: true, alwaysUseContainer: runtime === 'Container' } });
		test('server-renders the App Router app and HMR-updates each module type with client state preserved', async ({
			page,
			nativeProject: projectId,
		}) => {
			const unexpectedReloads: string[] = [];
			const websocketPaths = observedWebsocketPaths.get(page) ?? [];
			page.on('console', (message) => {
				if (message.text().includes('changed module not in running graph')) unexpectedReloads.push(message.text());
			});
			await waitForFileTree(page, 'app');
			await expect(page.getByRole('status', { name: runtime, exact: true })).toBeVisible({ timeout: 60_000 });

			const previewIframe = page.locator('iframe[title="Project Preview"]');
			const preview = page.frameLocator('iframe[title="Project Preview"]');

			// SSR: the server component renders, the client component hydrates.
			await expect(previewIframe).toBeVisible({ timeout: 60_000 });
			await expect(preview.getByRole('heading', { name: 'Hello vinext' })).toBeVisible({ timeout: 60_000 });
			const counter = preview.getByRole('button', { name: /Count:/ });
			await expect(counter).toBeVisible({ timeout: 60_000 });
			await expect(counter).toBeEnabled({ timeout: 60_000 });

			// Build up client state, and mark the document so a full reload is detectable.
			const previewHandle = await previewIframe.elementHandle();
			const previewFrame = await previewHandle?.contentFrame();
			if (!previewFrame) {
				throw new Error('Expected preview iframe to have a content frame');
			}
			const sentinel = await previewFrame.evaluate(() => {
				const value = `vinext-${Math.random().toString(36).slice(2)}`;
				Reflect.set(globalThis, '__vinextHmrSentinel', value);
				return value;
			});

			await counter.click();
			await expect(counter).toHaveText('Count: 1');
			await counter.click();
			await expect(counter).toHaveText('Count: 2');
			await expect.poll(() => websocketPaths).toContain(runtime === 'Container' ? '/__native-hmr' : '/__ws');

			// Server component edit → RSC refetch + reconcile, client state preserved.
			await editProjectFile(page, projectId, '/app/page.tsx', 'Hello vinext', 'Hello from HMR');
			await expect(preview.getByRole('heading', { name: 'Hello from HMR' })).toBeVisible({ timeout: 30_000 });
			await expect(counter).toHaveText('Count: 2');
			expect(await previewFrame.evaluate(() => Reflect.get(globalThis, '__vinextHmrSentinel'))).toBe(sentinel);
			expect(unexpectedReloads).toEqual([]);

			// Client component edit → React Fast Refresh, hook state preserved.
			await editProjectFile(page, projectId, '/app/counter.tsx', 'Count:', 'Tally:');
			await expect(preview.getByRole('button', { name: /Tally:/ })).toHaveText('Tally: 2', { timeout: 30_000 });
			expect(await previewFrame.evaluate(() => Reflect.get(globalThis, '__vinextHmrSentinel'))).toBe(sentinel);

			// Stylesheet edit → in-place <link> swap, no reload, client state preserved.
			await editProjectFile(page, projectId, '/app/globals.css', 'background: transparent;', 'background: rgb(7, 201, 91);');
			const styledButton = preview.getByRole('button', { name: /Tally:/ });
			await expect(styledButton).toHaveCSS('background-color', 'rgb(7, 201, 91)', { timeout: 30_000 });
			await expect(styledButton).toHaveText('Tally: 2');
			expect(await previewFrame.evaluate(() => Reflect.get(globalThis, '__vinextHmrSentinel'))).toBe(sentinel);

			// Refresh after edits must reconnect and leave the new document interactive.
			await page.getByRole('button', { name: 'Refresh', exact: true }).click();
			await expect(preview.getByRole('heading', { name: 'Hello from HMR' })).toBeVisible({ timeout: 30_000 });
			await expect(preview.getByRole('button', { name: /Tally:/ })).toHaveText('Tally: 0', { timeout: 30_000 });
			await expect(page.getByRole('status', { name: 'HMR connected', exact: true })).toBeVisible({ timeout: 30_000 });
			const refreshedFrameHandle = await previewIframe.elementHandle();
			const refreshedFrame = await refreshedFrameHandle?.contentFrame();
			if (!refreshedFrame) throw new Error('Expected refreshed preview iframe');
			expect(await refreshedFrame.evaluate(() => Reflect.get(globalThis, '__vinextHmrSentinel'))).toBeUndefined();
			await preview.getByRole('button', { name: /Tally:/ }).click();
			await expect(preview.getByRole('button', { name: /Tally:/ })).toHaveText('Tally: 1');
			await expect(page.getByRole('status', { name: runtime, exact: true })).toBeVisible();
			if (runtime === 'Worker') expect(websocketPaths).not.toContain('/__native-hmr');
		});
	});
}
