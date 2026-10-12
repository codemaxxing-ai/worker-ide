import { hc } from 'hono/client';

import { gotoIDE } from './helpers';
import { expect, test } from './test-fixtures';

import type { ApiRoutes } from '../../worker/routes';
import type { DevelopmentTestRoutes } from '../../worker/routes/development-test-routes';

test('editor edit → Computer execution → review → reject restores the editor baseline', async ({ page }) => {
	const projectId = await gotoIDE(page);
	const cookies = await page.context().cookies();
	const cookie = cookies.map((item) => `${item.name}=${item.value}`).join('; ');
	const base = `${new URL(page.url()).origin}/p/${projectId}/api`;
	const api = hc<ApiRoutes>(base, { headers: { Cookie: cookie } });
	const runtime = hc<DevelopmentTestRoutes>(base, { headers: { Cookie: cookie } });
	const edit = await api.file.$put({ json: { path: '/computer.txt', content: 'editor baseline\n' } });
	expect(edit.ok).toBe(true);
	const executed = await runtime.__test['computer-exec'].$post({
		json: { command: String.raw`cat computer.txt; printf "command change\n" > computer.txt`, snapshot: true, sessionId: 'computerreview' },
	});
	if (!executed.ok) throw new Error(`Computer execution failed: ${executed.status}`);
	const data = await executed.json();
	expect(data.result.exitCode).toBe(0);
	expect(data.result.stdout).toBe('editor baseline\n');
	if (!data.snapshotId) throw new Error('Missing execution snapshot');
	const pending = await api['pending-changes'].$put({
		json: {
			'/computer.txt': {
				path: '/computer.txt',
				action: 'edit',
				beforeContent: 'editor baseline\n',
				afterContent: 'command change\n',
				snapshotId: data.snapshotId,
				status: 'pending',
				hunkStatuses: ['pending'],
				sessionId: 'computerreview',
			},
		},
	});
	expect(pending.ok).toBe(true);
	await page.reload();
	await page.getByRole('button', { name: 'Toggle Agent panel' }).click();
	await page.getByRole('treeitem', { name: 'computer.txt', exact: true }).click();
	const review = page.locator('[data-diff-floating-bar]');
	await expect(review).toBeVisible();
	await expect(page.locator('.cm-content')).toContainText('command change');
	await review.getByRole('button', { name: 'Reject', exact: true }).click();
	await expect(review).toBeHidden();
	await expect
		.poll(async () => {
			const file = await api.file.$get({ query: { path: '/computer.txt' } });
			if (!file.ok) return;
			const restored = await file.json();
			return restored.content;
		})
		.toBe('editor baseline\n');
	await expect(page.locator('.cm-content')).toContainText('editor baseline');
});
