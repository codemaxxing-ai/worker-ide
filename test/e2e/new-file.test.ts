import { gotoIDE, waitForFileTree } from './helpers';
import { expect, test } from './test-fixtures';

test.describe('New File', () => {
	test('new file button opens the new file dialog', async ({ page }) => {
		await gotoIDE(page);
		await waitForFileTree(page);

		// Click the "New file" button in the sidebar header
		const newFileButton = page.getByLabel('New file', { exact: true });
		await expect(newFileButton).toBeVisible();
		let dialogMessage = '';
		page.once('dialog', async (dialog) => {
			expect(dialog.type()).toBe('prompt');
			dialogMessage = dialog.message();
			await dialog.dismiss();
		});
		await newFileButton.click();
		expect(dialogMessage).toBe('New file name');
	});

	test('creating a file adds it to the tree and opens it', async ({ page }) => {
		await gotoIDE(page);
		await waitForFileTree(page);

		// Open new file dialog
		page.once('dialog', async (dialog) => {
			expect(dialog.type()).toBe('prompt');
			await dialog.accept('hello.txt');
		});
		await page.getByLabel('New file', { exact: true }).click();

		// File should appear in the tree
		await expect(page.getByRole('treeitem', { name: 'hello.txt' })).toBeVisible();

		// A tab should open for the new file
		await expect(page.getByRole('tab', { name: /hello\.txt/i })).toBeVisible();
	});
});
