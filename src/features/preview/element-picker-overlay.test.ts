import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

declare global {
	var __PREVIEW_CONFIG:
		| {
				ideOrigin?: string;
		  }
		| undefined;
}

const ideOrigin = 'https://ide.example';
const viewportPadding = 6;
const labelWidth = 48;
const labelHeight = 20;
const targetElements: HTMLElement[] = [];
const parentPostMessage = vi.fn();

let hoveredElement: Element | undefined;

function overrideProperty(target: object, key: string, descriptor: PropertyDescriptor): () => void {
	const originalDescriptor = Object.getOwnPropertyDescriptor(target, key);
	Object.defineProperty(target, key, { configurable: true, ...descriptor });

	return () => {
		if (originalDescriptor) {
			Object.defineProperty(target, key, originalDescriptor);
			return;
		}

		Reflect.deleteProperty(target, key);
	};
}

function startPicker() {
	globalThis.dispatchEvent(
		new MessageEvent('message', { source: globalThis.parent, origin: ideOrigin, data: { type: '__preview-element-picker-start' } }),
	);
}

function movePickerToTarget() {
	globalThis.dispatchEvent(new MouseEvent('pointermove', { clientX: 32, clientY: 24 }));
}

function touchPicker(type: 'touchstart' | 'touchend', x: number, y: number) {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(event, type === 'touchend' ? 'changedTouches' : 'touches', {
		configurable: true,
		value: [{ clientX: x, clientY: y }],
	});
	globalThis.dispatchEvent(event);
}

function getFrameElement() {
	const frameElement = [...document.querySelectorAll('div')].find(
		(element) =>
			element.style.position === 'fixed' && element.style.boxSizing === 'border-box' && element.style.border.includes('2px solid'),
	);

	if (!frameElement) {
		throw new Error('Selection frame was not rendered');
	}

	return frameElement;
}

function getBackdropElement() {
	const backdropElement = [...document.querySelectorAll('div')].find((element) => element.style.position === 'absolute');

	if (!backdropElement) {
		throw new Error('Backdrop was not rendered');
	}

	return backdropElement;
}

function getPickerLabelElement() {
	const labelElement = [...document.querySelectorAll('div')].find(
		(element) => element.style.position === 'fixed' && element.style.display === 'inline-flex',
	);

	if (!labelElement) {
		throw new Error('Picker label was not rendered');
	}

	return labelElement;
}

function getLabelElement() {
	const labelElement = getPickerLabelElement();

	if (!labelElement.textContent?.startsWith('<')) {
		throw new Error('Selection label was not rendered');
	}

	return labelElement;
}

function createTarget(tagName: keyof HTMLElementTagNameMap, rect: DOMRect) {
	const target = document.createElement(tagName);
	target.getBoundingClientRect = () => rect;
	document.body.append(target);
	targetElements.push(target);
	return target;
}

describe('element picker overlay', () => {
	const restoreFunctions: Array<() => void> = [];

	beforeAll(async () => {
		globalThis.__PREVIEW_CONFIG = { ideOrigin };

		restoreFunctions.push(
			overrideProperty(globalThis, 'parent', { value: { postMessage: parentPostMessage } }),
			overrideProperty(globalThis, 'innerWidth', { value: 200 }),
			overrideProperty(globalThis, 'innerHeight', { value: 140 }),
			overrideProperty(document, 'elementFromPoint', { value: () => hoveredElement ?? document.body }),
			overrideProperty(HTMLElement.prototype, 'offsetWidth', { get: () => labelWidth }),
			overrideProperty(HTMLElement.prototype, 'offsetHeight', { get: () => labelHeight }),
		);

		// @ts-expect-error The preview script is a plain browser JS asset without TS types.
		await import('../../../worker/lib/preview-scripts/element-picker.js');
	});

	afterEach(() => {
		hoveredElement = undefined;
		parentPostMessage.mockClear();

		for (const target of targetElements.splice(0)) {
			target.remove();
		}
	});

	afterAll(() => {
		for (const restore of restoreFunctions.toReversed()) {
			restore();
		}

		globalThis.__PREVIEW_CONFIG = undefined;
	});

	it('shows the rainbow overlay without preselecting an element', () => {
		startPicker();

		const backdropElement = getBackdropElement();
		const frameElement = getFrameElement();
		const labelElement = getPickerLabelElement();

		expect(backdropElement.style.opacity).toBe('1');
		expect(frameElement.style.opacity).toBe('0');
		expect(labelElement.style.opacity).toBe('0');
	});

	it('ignores picker commands from other windows, other origins and malformed messages', () => {
		startPicker();
		globalThis.dispatchEvent(
			new MessageEvent('message', { source: globalThis.parent, origin: ideOrigin, data: { type: '__preview-element-picker-cancel' } }),
		);
		for (const message of [
			{ source: globalThis.window, origin: ideOrigin, data: { type: '__preview-element-picker-start' } },
			{ source: globalThis.parent, origin: 'https://sibling.example', data: { type: '__preview-element-picker-start' } },
			{ source: globalThis.parent, origin: ideOrigin, data: { type: 123 } },
		]) {
			globalThis.dispatchEvent(new MessageEvent<unknown>('message', message));
		}
		expect(getBackdropElement().style.opacity).toBe('0');
	});

	it('matches overflowing element bounds instead of clamping the selection frame', () => {
		const target = createTarget('div', new DOMRect(-10, 20, 260, 40));
		hoveredElement = target;

		startPicker();
		movePickerToTarget();

		const frameElement = getFrameElement();

		expect(frameElement.style.left).toBe('-16px');
		expect(frameElement.style.top).toBe('14px');
		expect(frameElement.style.width).toBe('272px');
		expect(frameElement.style.height).toBe('52px');
	});

	it('keeps the indicator label inside the visible preview window', () => {
		const target = createTarget('img', new DOMRect(150, 120, 110, 70));
		hoveredElement = target;

		startPicker();
		movePickerToTarget();

		const labelElement = getLabelElement();
		const labelLeft = Number.parseFloat(labelElement.style.left);
		const labelTop = Number.parseFloat(labelElement.style.top);

		expect(labelElement.textContent).toBe('<img>');
		expect(labelLeft).toBeGreaterThanOrEqual(viewportPadding);
		expect(labelLeft).toBeLessThanOrEqual(200 - viewportPadding - labelWidth);
		expect(labelTop).toBeGreaterThanOrEqual(viewportPadding);
		expect(labelTop).toBeLessThanOrEqual(140 - viewportPadding - labelHeight);
	});

	it('pins the indicator label to the top left for elements that enclose the viewport', () => {
		const target = createTarget('div', new DOMRect(0, 0, 200, 500));
		hoveredElement = target;

		startPicker();
		movePickerToTarget();

		const labelElement = getLabelElement();

		expect(labelElement.textContent).toBe('<div>');
		expect(labelElement.style.left).toBe('14px');
		expect(labelElement.style.top).toBe('14px');
	});

	it('supports touch selection without requiring a prior hover target', () => {
		const target = createTarget('button', new DOMRect(20, 12, 50, 24));
		hoveredElement = target;

		startPicker();
		touchPicker('touchstart', 32, 24);
		touchPicker('touchend', 32, 24);

		expect(parentPostMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: '__preview-element-picked',
				reference: expect.objectContaining({ tagName: 'button' }),
			}),
			ideOrigin,
		);
	});
});
