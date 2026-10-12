import { gotoIDE, waitForFileTree } from './helpers';
import { expect, test } from './test-fixtures';

test.describe('Editor Tabs', () => {
	test('opening a file creates a tab', async ({ page }) => {
		await gotoIDE(page);
		await waitForFileTree(page);

		// Click on index.html in the file tree
		await page.getByRole('treeitem', { name: 'index.html' }).click();

		// Tab should appear
		await expect(page.getByRole('tab', { name: /index\.html/i })).toBeVisible();
	});

	test('opening multiple files creates multiple tabs', async ({ page }) => {
		await gotoIDE(page);
		await waitForFileTree(page);

		// Open index.html
		await page.getByRole('treeitem', { name: 'index.html' }).click();
		await expect(page.getByRole('tab', { name: /index\.html/i })).toBeVisible();

		// Open tsconfig.json
		await page.getByRole('treeitem', { name: 'tsconfig.json' }).click();
		await expect(page.getByRole('tab', { name: /tsconfig\.json/i })).toBeVisible();

		// Both tabs should be present (scope to the file tab bar, not the utility panel)
		const fileTabBar = page.getByRole('tablist').first();
		const tabs = fileTabBar.getByRole('tab');
		await expect(tabs).toHaveCount(2);
	});

	test('clicking a tab switches to that file', async ({ page }) => {
		await gotoIDE(page);
		await waitForFileTree(page);

		// Open two files
		await page.getByRole('treeitem', { name: 'index.html' }).click();
		await page.getByRole('treeitem', { name: 'tsconfig.json' }).click();

		// tsconfig.json should be selected (last opened)
		const tsconfigTab = page.getByRole('tab', { name: /tsconfig\.json/i, selected: true });
		await expect(tsconfigTab).toBeVisible();

		// Click on index.html tab to switch
		const indexTab = page.getByRole('tab', { name: /index\.html/i });
		await indexTab.click();

		// index.html tab should now be selected
		await expect(indexTab).toHaveAttribute('aria-selected', 'true');
	});

	test('closing a tab removes it', async ({ page }) => {
		await gotoIDE(page);
		await waitForFileTree(page);

		// Open a file
		await page.getByRole('treeitem', { name: 'index.html' }).click();
		await expect(page.getByRole('tab', { name: /index\.html/i })).toBeVisible();

		// Close the tab via the close button
		const closeButton = page.getByRole('tab', { name: /index\.html/i }).getByLabel('Close');
		await closeButton.click();

		// Tab should be gone
		await expect(page.getByRole('tab', { name: /index\.html/i })).not.toBeVisible();

		// Should show empty editor placeholder again
		await expect(page.getByText('Select a file to edit')).toBeVisible();
	});
});
