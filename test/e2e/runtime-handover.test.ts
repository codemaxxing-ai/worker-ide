import { hc } from 'hono/client';

import { gotoIDE } from './helpers';
import { expect, test } from './test-fixtures';
import { WORKER_MODULE_BYTE_BUDGET } from '../../shared/worker-resource-budget';
import { localFetch } from '../local-https';

import type { ApiRoutes } from '../../worker/routes';

// These callbacks execute in the preview browser; the test runner's TS config
// contains Workers globals rather than DOM globals.
declare const history: { replaceState(data: unknown, title: string, url: string): void };
declare const location: { pathname: string; search: string; hash: string };
declare const scrollY: number;
declare function scrollTo(x: number, y: number): void;

test('promotes a project by size and preserves preview state in the same iframe', async ({ page }) => {
	const html = `<html><head><title>Runtime handover</title></head><body style="height:2000px"><input id="draft" aria-label="Draft"><button id="increment">Increment</button><output id="counter">0</output><script>
	let counter=0; const show=()=>document.getElementById('counter').textContent=String(counter);
	document.getElementById('increment').onclick=()=>{counter++;show()};
	window.__WORKER_IDE_PREVIEW_STATE__={capture:()=>({counter}),restore:state=>{counter=state.counter;show()}};
	</script></body></html>`;
	const projectId = await gotoIDE(page, { template: 'minimal', files: { '/index.html': html } });
	const iframe = page.locator('iframe[title="Project Preview"]');
	const frame = page.frameLocator('iframe[title="Project Preview"]');
	await expect(frame.getByRole('button', { name: 'Increment' })).toBeVisible();
	await expect(page.getByRole('status', { name: 'Worker', exact: true })).toBeVisible();
	const handle = await iframe.elementHandle();
	const preview = await handle?.contentFrame();
	if (!preview) throw new Error('Missing preview frame');
	await frame.getByRole('textbox', { name: 'Draft' }).fill('Keep this draft');
	await frame.getByRole('button', { name: 'Increment' }).click();
	await preview.evaluate(() => {
		history.replaceState(undefined, '', '/?tab=design#kept');
		localStorage.setItem('handover-local', 'kept');
		sessionStorage.setItem('handover-session', 'kept');
		scrollTo(0, 400);
	});
	await iframe.evaluate((element) => {
		Reflect.set(element, '__handoverSentinel', 'same-element');
	});
	const cookies = await page.context().cookies(page.url());
	const api = hc<ApiRoutes>(`${new URL(page.url()).origin}/p/${projectId}/api`, {
		fetch: localFetch,
		headers: { Cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ') },
	});
	const saved = await api.file.$put({ json: { path: '/runtime-pressure.js', content: `/*${'x'.repeat(WORKER_MODULE_BYTE_BUDGET)}*/` } });
	expect(saved.ok).toBe(true);
	// Warm outside Chromium's network stack: rootless Docker adds network interfaces.
	const previewCookies = await page.context().cookies(preview.url());
	const response = await localFetch(preview.url(), {
		headers: { Cookie: previewCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ') },
	});
	expect(response.ok).toBe(true);
	expect(response.headers.get('X-Worker-Ide-Runtime')).toBe('container');
	await response.arrayBuffer();
	await expect(page.getByRole('status', { name: 'Container', exact: true })).toBeVisible({ timeout: 90_000 });
	await expect(frame.getByRole('textbox', { name: 'Draft' })).toHaveValue('Keep this draft');
	await expect(frame.locator('#counter')).toHaveText('1');
	expect(
		await preview.evaluate(() => ({
			path: location.pathname + location.search + location.hash,
			local: localStorage.getItem('handover-local'),
			session: sessionStorage.getItem('handover-session'),
			scroll: scrollY,
		})),
	).toEqual({ path: '/?tab=design#kept', local: 'kept', session: 'kept', scroll: 400 });
	expect(await iframe.evaluate((element) => Reflect.get(element, '__handoverSentinel'))).toBe('same-element');
	const status = await api['runtime-status'].$get({});
	const runtimeStatus = await status.json();
	expect(runtimeStatus.preview).toMatchObject({ backend: 'container', phase: 'ready', reason: 'resource-limit' });
});
