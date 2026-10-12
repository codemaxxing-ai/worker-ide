import { gotoIDE } from './helpers';
import { expect, test } from './test-fixtures';

test.describe('Panel Toggling', () => {
	test('sidebar with file tree is visible', async ({ page }) => {
		await gotoIDE(page);

		await expect(page.getByText('Files', { exact: true })).toBeVisible();
	});

	test('utility panel is visible by default', async ({ page }) => {
		await gotoIDE(page);

		// Utility panel is shown by default
		// The collapse button should say "Hide utility panel"
		await expect(page.getByLabel('Hide utility panel')).toBeVisible();

		// The Output tabpanel should be visible
		await expect(page.getByRole('tabpanel', { name: 'Output' })).toBeVisible();
	});

	test('clicking utility panel toggle hides it', async ({ page }) => {
		await gotoIDE(page);

		// Utility panel is visible by default
		await expect(page.getByRole('tabpanel', { name: 'Output' })).toBeVisible();

		// Hide utility panel.
		// The auto-open-on-errors effect may re-expand if error logs arrive
		// right after we collapse. Retry once if that happens.
		const hideButton = page.getByLabel('Hide utility panel');
		const showButton = page.getByLabel('Show utility panel');

		await hideButton.click();

		try {
			await expect(showButton).toBeVisible({ timeout: 3000 });
		} catch {
			// Auto-open effect re-expanded — hide again
			await hideButton.click();
			await expect(showButton).toBeVisible({ timeout: 5000 });
		}

		// Output tab panel content should be gone (the header with the tab button stays visible)
		await expect(page.getByRole('tabpanel', { name: 'Output' })).not.toBeVisible();
	});

	test('clicking utility panel toggle again shows it', async ({ page }) => {
		await gotoIDE(page);

		// Hide utility panel.
		// The auto-open-on-errors effect (useLogCounts) can race with manual
		// toggling — if error logs arrive while the panel is hidden, the effect
		// re-opens it automatically. We retry the hide step until the collapsed
		// state actually sticks (no new errors arriving).
		const showButton = page.getByLabel('Show utility panel');
		const hideButton = page.getByLabel('Hide utility panel');

		await hideButton.click();
		// Wait for the collapsed state to settle. If auto-open re-expands
		// the panel, hide it again.
		try {
			await expect(showButton).toBeVisible({ timeout: 3000 });
		} catch {
			// Auto-open effect re-expanded the panel — hide it once more.
			// By now initial errors have been counted, so the effect won't fire again.
			await hideButton.click();
			await expect(showButton).toBeVisible({ timeout: 5000 });
		}

		// Show utility panel
		await showButton.click();
		await expect(page.getByRole('tabpanel', { name: 'Output' })).toBeVisible();
	});

	test('clicking Agent toggle shows the agent panel', async ({ page }) => {
		await gotoIDE(page);

		// Agent panel is hidden by default, Agent button should be visible
		const agentButton = page.getByLabel('Toggle Agent panel');
		await expect(agentButton).toBeVisible();

		await agentButton.click();

		await expect(page.getByText('Agent', { exact: true })).toBeVisible();
	});
});
