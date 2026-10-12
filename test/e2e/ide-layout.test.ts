import { gotoIDE } from './helpers';
import { expect, test } from './test-fixtures';

test.describe('IDE Layout', () => {
	test('renders the header with project name', async ({ page }) => {
		await gotoIDE(page);

		// Header should show a project name (human-readable ID like "jade-crow-63")
		const heading = page.locator('h1');
		await expect(heading).toBeVisible();
		// Human IDs follow the pattern: adjective-noun-number
		await expect(heading).toHaveText(/^[\w]+-[\w]+-\d+$/);
	});

	test('renders the sidebar with files label', async ({ page }) => {
		await gotoIDE(page);

		// Files label in sidebar header
		await expect(page.getByText('Files', { exact: true })).toBeVisible();
	});

	test('shows empty editor placeholder when no file is open', async ({ page }) => {
		await gotoIDE(page);

		await expect(page.getByText('Select a file to edit')).toBeVisible();
	});

	test('renders the status bar', async ({ page }) => {
		await gotoIDE(page);

		// Status bar is a <footer> element
		const footer = page.locator('footer');
		await expect(footer).toBeVisible();
	});

	test('shows download button in header', async ({ page }) => {
		await gotoIDE(page);

		await expect(page.getByRole('button', { name: /download/i })).toBeVisible();
	});
});
