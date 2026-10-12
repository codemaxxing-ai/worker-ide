import { gotoIDE, waitForFileTree } from './helpers';
import { expect, test } from './test-fixtures';

test.describe('Keyboard Shortcuts', () => {
	test('Ctrl+S triggers save (no error when no file is open)', async ({ page }) => {
		await gotoIDE(page);

		// No file is open, so Ctrl+S should be a no-op (no crash)
		await page.keyboard.press('Control+s');

		// App should still be functional — status bar is visible
		const footer = page.locator('footer');
		await expect(footer).toBeVisible();
	});

	test('Ctrl+S with a file open does not cause errors', async ({ page }) => {
		await gotoIDE(page);
		await waitForFileTree(page);

		// Open a file
		await page.getByRole('treeitem', { name: 'index.html' }).click();
		await expect(page.getByRole('tab', { name: /index\.html/i })).toBeVisible();

		// Press Ctrl+S — should trigger save without crashing
		await page.keyboard.press('Control+s');

		// App should still be functional
		const heading = page.locator('h1');
		await expect(heading).toBeVisible();
		await expect(page.getByRole('tab', { name: /index\.html/i })).toBeVisible();
	});
});
