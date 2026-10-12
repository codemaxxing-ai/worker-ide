import { hc } from 'hono/client';

import { gotoIDE } from './helpers';
import { expect, test } from './test-fixtures';
import { hostilePreviewFiles } from '../fixtures/hostile-preview';
import { localFetch } from '../local-https';

import type { ApiRoutes } from '../../worker/routes';
import type { Frame, Page } from 'playwright/test';

async function projectClient(page: Page, projectId: string) {
	const cookies = await page.context().cookies(page.url());
	return hc<ApiRoutes>(`${new URL(page.url()).origin}/p/${projectId}/api`, {
		fetch: localFetch,
		headers: { Cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ') },
	});
}

async function hostilePreview(page: Page): Promise<{ frame: Frame; projectId: string }> {
	const projectId = await gotoIDE(page, { files: hostilePreviewFiles });
	await expect(page.frameLocator('iframe[title="Project Preview"]').getByRole('heading', { name: 'Hostile preview' })).toBeVisible({
		timeout: 60_000,
	});
	const iframe = await page.getByTitle('Project Preview').elementHandle();
	const frame = await iframe?.contentFrame();
	if (!frame) throw new Error('Expected hosted preview');
	return { frame, projectId };
}

test('isolates two hostile projects from each other and from the editor', async ({ page, context }) => {
	const first = await hostilePreview(page);
	const secondPage = await context.newPage();
	const second = await hostilePreview(secondPage);
	const firstOrigin = new URL(first.frame.url()).origin;
	const secondOrigin = new URL(second.frame.url()).origin;
	expect(firstOrigin).not.toBe(secondOrigin);
	expect(new URL(firstOrigin).hostname).toMatch(/^[a-z0-9]+-[a-f0-9]{12}\.content\.localhost$/);
	await second.frame.evaluate(() => localStorage.setItem('secret', 'second project'));
	const attacks = await first.frame.evaluate(
		async ({ sibling, editor }) => {
			let parentBlocked = false;
			try {
				void Reflect.get(Reflect.get(globalThis, 'parent'), 'document');
			} catch {
				parentBlocked = true;
			}
			let relaxationBlocked = false;
			const document = Reflect.get(globalThis, 'document');
			try {
				document.domain = 'content.localhost';
				relaxationBlocked = document.domain !== 'content.localhost';
			} catch {
				relaxationBlocked = true;
			}
			// eslint-disable-next-line unicorn/consistent-function-scoping -- evaluated in the preview browser, not the test process
			const blocked = async (url: string) => {
				try {
					const options = { method: 'GET', credentials: 'include' };
					const response = await fetch(url, options);
					return !response.ok;
				} catch {
					return true;
				}
			};
			return {
				parentBlocked,
				relaxationBlocked,
				storage: localStorage.getItem('secret') ?? undefined,
				siblingBlocked: await blocked(`${sibling}/api/inspect`),
				editorBlocked: await blocked(`${editor}/api/user/preferences`),
			};
		},
		{ sibling: secondOrigin, editor: new URL(page.url()).origin },
	);
	expect(attacks).toEqual({ parentBlocked: true, relaxationBlocked: true, storage: undefined, siblingBlocked: true, editorBlocked: true });
	const inspectedRequest = page.waitForRequest(`${firstOrigin}/api/inspect`);
	const credentials = await first.frame.evaluate(async () => {
		const response = await fetch('/api/inspect', { headers: { Authorization: 'user-secret' } });
		return {
			data: await response.json(),
			cors: response.headers.get('Access-Control-Allow-Origin'),
			workerScope: response.headers.get('Service-Worker-Allowed'),
		};
	});
	expect(credentials.data).toMatchObject({ headers: expect.any(Object) });
	if (!credentials.data || typeof credentials.data !== 'object' || !('headers' in credentials.data))
		throw new Error('Expected inspected headers');
	expect(credentials.data.headers).not.toHaveProperty('cookie');
	expect(credentials.data.headers).not.toHaveProperty('authorization');
	expect(credentials.cors).toBeNull();
	expect(credentials.workerScope).toBeNull();
	const previewRequest = await inspectedRequest;
	const sentHeaders = await previewRequest.allHeaders();
	expect(sentHeaders.cookie ?? '').not.toContain('better-auth');
	const storedCookies = await context.cookies();
	expect(storedCookies.some((cookie) => cookie.name === 'generated-secret')).toBe(false);
	await secondPage.close();
});

test('blocks service workers and nested frames while preserving ordinary workers and element picking', async ({
	page,
	context,
	browserName,
}) => {
	const { frame } = await hostilePreview(page);
	const workerResults = await frame.evaluate(async () => {
		let serviceWorkerBlocked = false;
		try {
			await Reflect.get(navigator, 'serviceWorker').register('/service-worker.js');
		} catch {
			serviceWorkerBlocked = true;
		}
		const ordinaryWorker = await new Promise<string>((resolve, reject) => {
			const BrowserWorker = Reflect.get(globalThis, 'Worker');
			const worker = new BrowserWorker('/ordinary-worker.js');
			worker.addEventListener('message', (event: { data: string }) => {
				worker.terminate();
				resolve(event.data);
			});
			worker.addEventListener('error', reject);
		});
		const nestedFrameBlocked = await new Promise<boolean>((resolve) => {
			const document = Reflect.get(globalThis, 'document');
			document.addEventListener(
				'securitypolicyviolation',
				(event: { effectiveDirective: string }) => {
					if (event.effectiveDirective === 'frame-src') resolve(true);
				},
				{ once: true },
			);
			const nested = document.createElement('iframe');
			nested.src = '/';
			document.body.append(nested);
			setTimeout(() => resolve(false), 2000);
		});
		return { serviceWorkerBlocked, ordinaryWorker, nestedFrameBlocked };
	});
	expect(workerResults).toEqual({ serviceWorkerBlocked: true, ordinaryWorker: 'worker alive', nestedFrameBlocked: true });
	if (browserName === 'chromium') {
		await context.grantPermissions(['clipboard-write'], { origin: new URL(page.url()).origin });
		await context.grantPermissions(['clipboard-write'], { origin: new URL(frame.url()).origin });
	}
	await page.bringToFront();
	await frame.getByRole('button', { name: 'Copy', exact: true }).click();
	await expect(frame.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Send to Agent', exact: true }).click();
	await frame.getByRole('heading', { name: 'Hostile preview' }).click();
	await expect(page.getByRole('button', { name: 'Send to Agent', exact: true })).not.toHaveClass(/bg-accent\/10/);
	await expect(page.locator('iframe[title="Project Preview"]')).toHaveAttribute('allow', 'clipboard-write');
	await expect(page.locator('iframe[title="Project Preview"]')).toHaveAttribute('referrerpolicy', 'no-referrer');
});

test('private previews authenticate or offer standalone access when iframe cookies are blocked', async ({ page, context, browserName }) => {
	const { frame, projectId } = await hostilePreview(page);
	const api = await projectClient(page, projectId);
	const visibility = await api.project.visibility.$put({ json: { visibility: 'private' } });
	expect(visibility.ok).toBe(true);
	const origin = new URL(frame.url()).origin;
	await page.clock.install();
	const redemption = page.waitForResponse((response) => new URL(response.url()).pathname === '/__preview-auth/redeem');
	const cookieCheck = page.waitForResponse((response) => new URL(response.url()).pathname === '/__preview-auth/check');
	await page.getByRole('button', { name: 'Refresh', exact: true }).click();
	const redeemed = await redemption;
	expect(redeemed.status()).toBe(302);
	// WebKit omits rejected Set-Cookie headers from its browser protocol response.
	const redemptionResponse = await localFetch(redeemed.url(), { redirect: 'manual' });
	const cookieHeader = redemptionResponse.headers.get('set-cookie');
	expect(cookieHeader).toContain('__Host-worker-ide-preview-access=');
	for (const attribute of ['Secure', 'HttpOnly', 'Path=/', 'SameSite=None', 'Partitioned']) expect(cookieHeader).toContain(attribute);
	expect(cookieHeader).not.toContain('Domain=');
	const checked = await cookieCheck;
	if (checked.status() === 403) {
		// The Linux WebKit port rejects third-party preview cookies. Exercise the real bounded fallback without weakening policy.
		expect(browserName).toBe('webkit');
		await expect(page.getByRole('button', { name: 'Open preview', exact: true })).toBeVisible();
		await expect(page.getByText('Loading preview...', { exact: true })).not.toBeVisible();
	} else {
		expect(checked.status()).toBe(302);
		await expect.poll(() => !!checked.request().redirectedTo()).toBe(true);
		const contentRequest = checked.request().redirectedTo();
		if (!contentRequest) throw new Error('Expected private preview document redirect');
		const privateResponse = await contentRequest.response();
		if (!privateResponse) throw new Error('Expected private preview document response');
		expect(privateResponse.status()).toBe(200);
		await privateResponse.finished();
		await expect(page.frameLocator('iframe[title="Project Preview"]').getByRole('heading', { name: 'Hostile preview' })).toBeVisible();
		const renewedAccess = page.waitForResponse((response) => response.url().endsWith('/api/preview-url'));
		const renewedDocument = page.waitForResponse(
			(response) =>
				response.request().resourceType() === 'document' && new URL(response.url()).pathname === '/' && response.status() === 200,
		);
		await page.clock.fastForward(55 * 60 * 1000);
		// The server retains real time. Restore wall time before loading the newly issued grant.
		await page.clock.setSystemTime(new Date());
		const renewedResponse = await renewedAccess;
		expect(renewedResponse.ok()).toBe(true);
		const renewedPreview = await renewedDocument;
		await renewedPreview.finished();
		await expect(page.frameLocator('iframe[title="Project Preview"]').getByRole('heading', { name: 'Hostile preview' })).toBeVisible();
	}
	await context.clearCookies({ name: '__Host-worker-ide-preview-access' });
	const standalone = await context.newPage();
	const bootstrap = standalone.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/__preview-auth/bootstrap'));
	await standalone.goto(origin);
	const bootstrapResponse = await bootstrap;
	expect(bootstrapResponse.status()).toBe(302);
	await expect(standalone.getByRole('heading', { name: 'Hostile preview' })).toBeVisible();
	expect(standalone.url()).toBe(`${origin}/`);
	const inspected = await standalone.evaluate(async () => {
		const response = await fetch('/api/inspect', { headers: { Authorization: 'user-secret' } });
		return response.json();
	});
	if (!inspected || typeof inspected !== 'object' || !('headers' in inspected)) throw new Error('Expected inspected headers');
	expect(inspected.headers).not.toHaveProperty('cookie');
	expect(inspected.headers).not.toHaveProperty('authorization');
	const cookies = await context.cookies(origin);
	expect(
		cookies.some(
			(cookie) => cookie.name === '__Host-worker-ide-preview-access' && cookie.secure && cookie.httpOnly && cookie.sameSite === 'None',
		),
	).toBe(true);
	await standalone.close();
});

test('cookie rejection produces a bounded Open preview action', async ({ page }) => {
	const { projectId } = await hostilePreview(page);
	const api = await projectClient(page, projectId);
	const visibility = await api.project.visibility.$put({ json: { visibility: 'private' } });
	expect(visibility.ok).toBe(true);
	await page.route('**/__preview-auth/redeem?*', async (route) => {
		const response = await localFetch(route.request().url(), { redirect: 'manual' });
		const checkLocation = response.headers.get('location');
		if (response.status !== 302 || !checkLocation) throw new Error('Expected preview cookie check redirect');
		const checkUrl = new URL(checkLocation, route.request().url()).toString();
		const headers = Object.fromEntries(response.headers);
		delete headers['set-cookie'];
		delete headers.location;
		headers['content-type'] = 'text/html';
		// WebKit cannot fulfill a mocked HTTP redirect. Navigate to the real check without accepting the cookie.
		await route.fulfill({ status: 200, headers, body: `<script>location.replace(${JSON.stringify(checkUrl)})</script>` });
	});
	await page.getByRole('button', { name: 'Refresh', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Open preview', exact: true })).toBeVisible({ timeout: 30_000 });
	await expect(page.getByText('Loading preview...', { exact: true })).not.toBeVisible();
});

test('preserves DevTools and embedded and standalone error deep links', async ({ page, context }) => {
	const { frame, projectId } = await hostilePreview(page);
	await page.getByRole('button', { name: 'Toggle DevTools', exact: true }).click();
	const devtools = page.frameLocator('iframe[title="DevTools"]');
	await expect(devtools.getByRole('tab', { name: 'Elements', exact: true })).toBeVisible({ timeout: 60_000 });
	await expect(devtools.getByText('Hostile preview', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
	await page.getByRole('button', { name: 'Toggle DevTools', exact: true }).click();
	await frame.evaluate(() =>
		Reflect.get(globalThis, 'showErrorOverlay')({ message: 'Test error', location: { file: '/index.html', line: 1, column: 1 } }),
	);
	await frame.locator('.__eo-file').click();
	await expect(page.getByRole('tab', { name: /index\.html/i })).toBeVisible();
	const standalone = await context.newPage();
	await standalone.goto(new URL(frame.url()).origin);
	await standalone.evaluate(() =>
		Reflect.get(globalThis, 'showErrorOverlay')({ message: 'Test error', location: { file: '/index.html', line: 1, column: 1 } }),
	);
	const editorOpened = context.waitForEvent('page');
	await standalone.locator('.__eo-file').click();
	const editor = await editorOpened;
	await expect(editor).toHaveURL(new RegExp(String.raw`/p/${projectId}\?file=`));
	expect(await editor.evaluate(() => !Reflect.get(globalThis, 'opener'))).toBe(true);
	await editor.close();
	await standalone.close();
});

test('rejects framing by an unauthorized site', async ({ page, context, browserName }) => {
	const { frame } = await hostilePreview(page);
	const attacker = await context.newPage();
	const origin = new URL(frame.url()).origin;
	// Reach the live localhost server so this test exercises frame-ancestors.
	if (browserName === 'chromium') await context.grantPermissions(['local-network-access'], { origin: 'https://attacker.localhost:3000' });
	await attacker.route('https://attacker.localhost:3000/', (route) =>
		route.fulfill({ contentType: 'text/html', body: `<!DOCTYPE html><iframe title="Stolen preview" src="${origin}"></iframe>` }),
	);
	const framingBlocked = attacker.waitForEvent('console', {
		predicate: (message) => message.text().includes('frame-ancestors'),
		timeout: 15_000,
	});
	const previewRequested = attacker.waitForResponse((response) => response.url() === `${origin}/`, { timeout: 15_000 });
	await attacker.goto('https://attacker.localhost:3000/');
	await previewRequested;
	await framingBlocked;
	await attacker.close();
});
