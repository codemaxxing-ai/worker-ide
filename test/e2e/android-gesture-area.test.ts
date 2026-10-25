import { devices, expect, test } from 'playwright/test';

import type { Page } from 'playwright/test';

// Browser callbacks run with DOM APIs; the runner uses Workers globals.
declare const document: {
	body: { style: { display: string; removeProperty(name: string): void }; append(element: unknown): void };
	documentElement: unknown;
	createElement(name: string): { style: { cssText: string } };
};
declare function getComputedStyle(element: unknown, pseudoElement: string): { bottom: string; content: string };

test.beforeEach(async ({ page }) => {
	await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ contentType: 'text/css', body: '' }));
});

async function expectBlackGestureArea(page: Page, height: number): Promise<void> {
	const viewport = page.viewportSize();
	if (!viewport) throw new Error('Missing viewport');
	const clip = { x: 0, y: viewport.height - height, width: viewport.width, height };
	const gestureArea = await page.screenshot({ clip });
	await page.evaluate(() => {
		document.body.style.display = 'none';
	});
	try {
		// The empty black document canvas is the pixel reference for the system bar.
		const blackCanvas = await page.screenshot({ clip });
		expect(gestureArea.equals(blackCanvas), 'the entire gesture area should be opaque black').toBe(true);
	} finally {
		await page.evaluate(() => {
			document.body.style.removeProperty('display');
		});
	}
}

test.describe('Android edge-to-edge', () => {
	test.skip(({ browserName }) => browserName !== 'chromium', 'Android Chrome uses Chromium safe-area emulation');
	test.use({
		userAgent: devices['Pixel 7'].userAgent,
		isMobile: true,
		hasTouch: true,
		deviceScaleFactor: 1,
		viewport: { width: 390, height: 844 },
	});

	for (const theme of ['light', 'dark']) {
		test(`keeps the gesture area black in ${theme} mode`, async ({ page, context }) => {
			await page.addInitScript((colorScheme) => {
				localStorage.setItem('worker-ide-preferences', JSON.stringify({ colorScheme }));
			}, theme);
			const session = await context.newCDPSession(page);
			await session.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: 24, bottomMax: 34 } });
			await page.goto('/', { waitUntil: 'domcontentloaded' });
			await expect(page.locator('html')).toHaveAttribute('data-platform', 'android');
			await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
			await expect(page.locator('body')).toHaveCSS('background-color', theme === 'light' ? 'rgb(255, 253, 251)' : 'rgb(18, 18, 18)');
			await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#000000');
			await expectBlackGestureArea(page, 24);

			// A full-screen surface must not repaint the gesture area.
			await page.evaluate(() => {
				const surface = document.createElement('div');
				surface.style.cssText = 'position:fixed;inset:0;z-index:100;background:white';
				document.body.append(surface);
			});
			await expectBlackGestureArea(page, 24);
			await page.setViewportSize({ width: 844, height: 390 });
			await expectBlackGestureArea(page, 24);
			await session.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: 0, bottomMax: 34 } });
			await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement, '::after').bottom)).toBe('-34px');
			await session.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: 0, bottomMax: 0 } });
			await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(0, 0, 0)');

			const manifestPath = await page.locator('link[rel="manifest"]').getAttribute('href');
			if (!manifestPath) throw new Error('Missing PWA manifest');
			const response = await page.request.get(manifestPath);
			const manifest = await response.json();
			expect(manifest.background_color).toBe('#000000');
			expect(manifest.theme_color).toBe('#000000');
		});
	}
});

test.describe('iOS safe area', () => {
	test.skip(({ browserName }) => browserName !== 'chromium', 'Uses Chromium safe-area emulation with an iPhone user agent');
	test.use({ userAgent: devices['iPhone 13'].userAgent, viewport: devices['iPhone 13'].viewport, isMobile: true, hasTouch: true });

	test('keeps the existing safe-area treatment', async ({ page, context }) => {
		const session = await context.newCDPSession(page);
		await session.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: 24, bottomMax: 24 } });
		await page.goto('/', { waitUntil: 'domcontentloaded' });
		await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(18, 18, 18)');
		await expect(page.locator('html')).not.toHaveAttribute('data-platform');
		expect(await page.evaluate(() => getComputedStyle(document.documentElement, '::after').content)).toBe('none');
	});
});
