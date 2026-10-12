import { gotoIDE, waitForFileTree } from './helpers';
import { expect, test } from './test-fixtures';

import type { Page } from 'playwright/test';

interface FileResponse {
	content: string;
}

/** Read a project file, apply a replacement, and save it back through the API. */
async function editProjectFile(page: Page, projectId: string, path: string, find: string, replace: string): Promise<void> {
	const updated = await page.evaluate(
		async ({ currentProjectId, filePath, search, replacement }) => {
			const read = await fetch(`/p/${currentProjectId}/api/file?path=${encodeURIComponent(filePath)}`);
			if (!read.ok) {
				throw new Error(`Failed to load ${filePath}: ${read.status}`);
			}
			const data: FileResponse = await read.json();
			if (!data.content.includes(search)) {
				throw new Error(`Expected ${filePath} to contain ${JSON.stringify(search)}`);
			}
			return data.content.replace(search, replacement);
		},
		{ currentProjectId: projectId, filePath: path, search: find, replacement: replace },
	);

	await page.evaluate(
		async ({ currentProjectId, filePath, content }) => {
			const response = await fetch(`/p/${currentProjectId}/api/file`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: filePath, content }),
			});
			if (!response.ok) {
				throw new Error(`Failed to save ${filePath}: ${response.status}`);
			}
		},
		{ currentProjectId: projectId, filePath: path, content: updated },
	);
}

test.describe('vinext preview + HMR', () => {
	test('server-renders the App Router app and HMR-updates each module type with client state preserved', async ({ page }) => {
		const unexpectedReloads: string[] = [];
		page.on('console', (message) => {
			if (message.text().includes('changed module not in running graph')) unexpectedReloads.push(message.text());
		});
		const projectId = await gotoIDE(page, { template: 'vinext' });
		await waitForFileTree(page, 'app');

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
	});
});
