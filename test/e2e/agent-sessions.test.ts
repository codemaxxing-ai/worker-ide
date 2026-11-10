import { hc } from 'hono/client';

import { gotoIDE } from './helpers';
import { expect, test } from './test-fixtures';
import { localFetch } from '../local-https';

import type { ApiRoutes } from '../../worker/routes';
import type { Page } from '@playwright/test';

async function showAgentPanel(page: Page) {
	const toggle = page.getByRole('button', { name: 'Toggle Agent panel' });
	await expect(toggle).toBeVisible();
	if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
	await expect(page.locator('#agent-session-menu')).toBeVisible({ timeout: 30_000 });
}

test('keeps chat selection and drafts local to each tab while sharing rename and deletion', async ({ page, context }) => {
	const projectId = await gotoIDE(page);
	await showAgentPanel(page);
	await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled({ timeout: 30_000 });
	const cookies = await context.cookies();
	const cookie = cookies.map((item) => `${item.name}=${item.value}`).join('; ');
	const api = hc<ApiRoutes>(`${new URL(page.url()).origin}/p/${projectId}/api`, { fetch: localFetch, headers: { Cookie: cookie } });
	for (const title of ['Session A', 'Session B']) {
		const created = await api.agent.sessions.$post({ json: { id: crypto.randomUUID(), title } });
		expect(created.ok).toBe(true);
	}
	await page.getByRole('button', { name: 'Session history' }).click();
	await page.getByRole('button', { name: 'Session A', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled({ timeout: 30_000 });
	await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Draft A');

	const second = await context.newPage();
	await second.goto(page.url());
	await showAgentPanel(second);
	await expect(second.locator('#agent-session-menu')).toHaveText('New session', { timeout: 30_000 });
	await second.getByRole('button', { name: 'Session history' }).click();
	await second.getByRole('button', { name: 'Session B', exact: true }).click();
	await expect(second.getByRole('button', { name: 'Send message' })).toBeEnabled({ timeout: 30_000 });
	await second.getByRole('textbox', { name: 'Message', exact: true }).fill('Draft B');
	await expect(page.locator('#agent-session-menu')).toHaveText('Session A');
	await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveText('Draft A');
	await page.reload();
	await showAgentPanel(page);
	await expect(page.locator('#agent-session-menu')).toHaveText('Session A');
	await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveText('Draft A');
	await expect(second.getByRole('textbox', { name: 'Message', exact: true })).toHaveText('Draft B');

	await page.getByRole('button', { name: 'Session history' }).click();
	await page.getByRole('button', { name: 'Rename Session A', exact: true }).click();
	await page.getByRole('textbox', { name: 'Session title' }).fill('Renamed session');
	await page.getByRole('button', { name: 'Save session title' }).click();
	await expect(page.locator('#agent-session-menu')).toHaveText('Renamed session');
	await page.getByRole('textbox', { name: 'Search sessions' }).fill('Renamed');
	await expect(page.getByRole('button', { name: 'Session B', exact: true })).toBeHidden();
	await expect(
		page.getByRole('region', { name: 'Agent sessions' }).getByRole('button', { name: 'Renamed session', exact: true }),
	).toBeVisible();

	await second.getByRole('button', { name: 'Session history' }).click();
	await second.getByRole('button', { name: 'Delete Session B', exact: true }).click();
	await second.getByRole('group', { name: 'Delete Session B?' }).getByRole('button', { name: 'Delete', exact: true }).click();
	await expect(second.locator('#agent-session-menu')).toHaveText('New session');
	await expect(page.locator('#agent-session-menu')).toHaveText('Renamed session');
	await second.close();
});
