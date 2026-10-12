import { gotoIDE, waitForFileTree } from './helpers';
import { expect, test } from './test-fixtures';

interface FileResponse {
	content: string;
}

test.describe('Preview HMR', () => {
	test('applies React updates without reloading the preview iframe', async ({ page }) => {
		const projectId = await gotoIDE(page);
		await waitForFileTree(page);

		const previewIframe = page.locator('iframe[title="Project Preview"]');
		const previewFrameLocator = page.frameLocator('iframe[title="Project Preview"]');

		await expect(previewIframe).toBeVisible({ timeout: 30_000 });
		await expect(previewFrameLocator.getByRole('heading', { name: /request inspector/i })).toBeVisible({ timeout: 30_000 });

		const previewFrameHandle = await previewIframe.elementHandle();
		const previewFrame = await previewFrameHandle?.contentFrame();
		if (!previewFrame) {
			throw new Error('Expected preview iframe to have a content frame');
		}

		const sentinel = await previewFrame.evaluate(() => {
			const value = `hmr-${Math.random().toString(36).slice(2)}`;
			Reflect.set(globalThis, '__previewHmrSentinel', value);
			return value;
		});

		const updatedContent = await page.evaluate(
			async ({ currentProjectId }) => {
				const response = await fetch(`/p/${currentProjectId}/api/file?path=${encodeURIComponent('/src/app.tsx')}`);
				if (!response.ok) {
					throw new Error(`Failed to load source file: ${response.status}`);
				}

				const data: FileResponse = await response.json();
				return data.content.replace('See what your Cloudflare Worker knows about each request', 'Preview HMR is live');
			},
			{ currentProjectId: projectId },
		);

		expect(updatedContent).toContain('Preview HMR is live');

		await page.evaluate(
			async ({ content, currentProjectId }) => {
				const response = await fetch(`/p/${currentProjectId}/api/file`, {
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ path: '/src/app.tsx', content }),
				});
				if (!response.ok) {
					throw new Error(`Failed to save source file: ${response.status}`);
				}
			},
			{ content: updatedContent, currentProjectId: projectId },
		);

		await expect(previewFrameLocator.getByText('Preview HMR is live', { exact: true })).toBeVisible({ timeout: 30_000 });

		const sentinelAfterUpdate = await previewFrame.evaluate(() => Reflect.get(globalThis, '__previewHmrSentinel'));
		expect(sentinelAfterUpdate).toBe(sentinel);
	});
});
