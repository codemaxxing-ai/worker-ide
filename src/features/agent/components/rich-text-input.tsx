import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { usePreviewReferenceInteractions } from '@/features/agent/lib/reference-actions';
import {
	FILE_REFERENCE_BASE_CLASS_NAME,
	FILE_REFERENCE_INTERACTIVE_CLASS_NAME,
	FILE_REFERENCE_LABEL_CLASS_NAME,
	PREVIEW_REFERENCE_BASE_CLASS_NAME,
	PREVIEW_REFERENCE_ICON_CLASS_NAME,
	PREVIEW_REFERENCE_INTERACTIVE_CLASS_NAME,
	PREVIEW_REFERENCE_LABEL_CLASS_NAME,
	PREVIEW_REFERENCE_MISSING_CLASS_NAME,
	PREVIEW_REFERENCE_SUMMARY_CLASS_NAME,
	PREVIEW_REFERENCE_TEXT_ROW_CLASS_NAME,
} from '@/features/agent/lib/reference-pill-styles';
import { resolvePreviewElement } from '@/features/preview/preview-iframe-reference';
import { useFileTargetOpener } from '@/lib/file-target';
import { deserializePreviewElementReference, serializePreviewElementReference } from '@/lib/preview-element-reference';
import { cn } from '@/lib/utils';
import {
	getPreviewElementDisplayText,
	getPreviewElementLabel,
	getPreviewElementReferenceKey,
	getPreviewElementSummary,
} from '@shared/preview-element';

import { segmentsToPlainText, type InputSegment, type PreviewElementSegment } from '../lib/input-segments';

import type { PreviewElementReference } from '@shared/types';

export interface RichTextInputHandle {
	focus: () => void;
	setCursorPosition: (offset: number) => void;
	moveCursorToEnd: () => void;
	insertMention: (path: string, triggerOffset: number, queryLength: number) => void;
	getPlainText: () => string;
	clear: () => void;
}

const PILL_ATTR = 'data-mention-path';
const PREVIEW_ELEMENT_REFERENCE_ATTR = 'data-preview-element-reference';

function getFileName(path: string): string {
	return path.split('/').pop() ?? path;
}

function areSetsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
	if (left.size !== right.size) {
		return false;
	}

	for (const value of left) {
		if (!right.has(value)) {
			return false;
		}
	}

	return true;
}

function normalizeContainerDom(container: HTMLElement): void {
	while (container.firstChild instanceof HTMLBRElement) {
		container.firstChild.remove();
	}
}

function parseSegmentsFromDom(container: HTMLElement): InputSegment[] {
	const segments: InputSegment[] = [];

	for (const node of container.childNodes) {
		if (node.nodeType === Node.TEXT_NODE) {
			const text = node.textContent ?? '';
			if (text) {
				segments.push({ type: 'text', value: text });
			}
		} else if (node.nodeType === Node.ELEMENT_NODE) {
			const element = node instanceof HTMLElement ? node : undefined;
			if (element) {
				const mentionPath = element.getAttribute(PILL_ATTR);
				const previewElementReference = deserializePreviewElementReference(element.getAttribute(PREVIEW_ELEMENT_REFERENCE_ATTR) ?? '');
				if (mentionPath) {
					segments.push({ type: 'mention', path: mentionPath });
				} else if (previewElementReference) {
					segments.push({ type: 'preview-element', ...previewElementReference });
				} else if (element.tagName === 'BR') {
					segments.push({ type: 'text', value: '\n' });
				} else {
					const text = element.textContent ?? '';
					if (text) {
						segments.push({ type: 'text', value: text });
					}
				}
			}
		}
	}

	return segments;
}

function getSegmentTextLength(segment: InputSegment): number {
	return segmentsToPlainText([segment]).length;
}

function getSegmentsTextLength(segments: InputSegment[]): number {
	return segmentsToPlainText(segments).length;
}

function normalizeSegments(segments: InputSegment[]): InputSegment[] {
	const normalizedSegments: InputSegment[] = [];

	for (const segment of segments) {
		if (segment.type === 'text') {
			if (!segment.value) {
				continue;
			}

			const previousSegment = normalizedSegments.at(-1);
			if (previousSegment?.type === 'text') {
				previousSegment.value += segment.value;
				continue;
			}
		}

		normalizedSegments.push(segment);
	}

	return normalizedSegments;
}

function getSegmentStartOffset(segments: InputSegment[], segmentIndex: number): number {
	let offset = 0;

	for (const [index, segment] of segments.entries()) {
		if (index === segmentIndex) {
			return offset;
		}

		offset += getSegmentTextLength(segment);
	}

	return offset;
}

function getAdjacentRemovableSegmentIndex(
	segments: InputSegment[],
	cursorOffset: number,
	direction: 'backward' | 'forward',
): number | undefined {
	let offset = 0;

	for (const [index, segment] of segments.entries()) {
		const segmentLength = getSegmentTextLength(segment);
		const segmentStart = offset;
		const segmentEnd = offset + segmentLength;

		if (segment.type !== 'text') {
			if (direction === 'backward' && cursorOffset === segmentEnd) {
				return index;
			}

			if (direction === 'forward' && cursorOffset === segmentStart) {
				return index;
			}
		}

		offset = segmentEnd;
	}

	return undefined;
}

function getLeadingPlaceholderBreakCount(container: HTMLElement): number {
	let count = 0;

	for (const childNode of container.childNodes) {
		if (!(childNode instanceof HTMLBRElement)) {
			break;
		}

		count += 1;
	}

	return count;
}

function getCursorOffsetInContainer(container: HTMLElement): number {
	const selection = globalThis.getSelection();
	if (!selection || selection.rangeCount === 0) return -1;

	const range = selection.getRangeAt(0);
	const preRange = document.createRange();
	preRange.setStart(container, 0);
	preRange.setEnd(range.startContainer, range.startOffset);

	const fragment = preRange.cloneContents();
	let offset = 0;

	function walk(node: Node): void {
		if (node.nodeType === Node.TEXT_NODE) {
			offset += (node.textContent ?? '').length;
		} else if (node.nodeType === Node.ELEMENT_NODE) {
			const element = node instanceof HTMLElement ? node : undefined;
			if (element) {
				const mentionPath = element.getAttribute(PILL_ATTR);
				const previewElementReference = deserializePreviewElementReference(element.getAttribute(PREVIEW_ELEMENT_REFERENCE_ATTR) ?? '');
				if (mentionPath) {
					offset += getSegmentTextLength({ type: 'mention', path: mentionPath });
				} else if (previewElementReference) {
					offset += getSegmentTextLength({ type: 'preview-element', ...previewElementReference });
				} else if (element.tagName === 'BR') {
					offset += 1;
				} else {
					for (const child of node.childNodes) {
						walk(child);
					}
				}
			}
		}
	}

	for (const child of fragment.childNodes) {
		walk(child);
	}

	return Math.max(0, offset - getLeadingPlaceholderBreakCount(container));
}
function findDomPosition(container: HTMLElement, targetOffset: number): { node: Node; offset: number } | undefined {
	let accumulated = 0;

	for (const child of container.childNodes) {
		if (child.nodeType === Node.TEXT_NODE) {
			const length = (child.textContent ?? '').length;
			if (accumulated + length >= targetOffset) {
				return { node: child, offset: targetOffset - accumulated };
			}
			accumulated += length;
		} else if (child.nodeType === Node.ELEMENT_NODE) {
			const element = child instanceof HTMLElement ? child : undefined;
			if (element) {
				const mentionPath = element.getAttribute(PILL_ATTR);
				const previewElementReference = deserializePreviewElementReference(element.getAttribute(PREVIEW_ELEMENT_REFERENCE_ATTR) ?? '');
				if (mentionPath) {
					const mentionLength = getSegmentTextLength({ type: 'mention', path: mentionPath });
					if (accumulated + mentionLength >= targetOffset) {
						const index = [...container.childNodes].indexOf(child);
						return { node: container, offset: index + 1 };
					}
					accumulated += mentionLength;
				} else if (previewElementReference) {
					const previewElementLength = getSegmentTextLength({ type: 'preview-element', ...previewElementReference });
					if (accumulated + previewElementLength >= targetOffset) {
						const index = [...container.childNodes].indexOf(child);
						return { node: container, offset: index + 1 };
					}
					accumulated += previewElementLength;
				} else if (element.tagName === 'BR') {
					if (accumulated + 1 >= targetOffset) {
						const index = [...container.childNodes].indexOf(child);
						return { node: container, offset: index + 1 };
					}
					accumulated += 1;
				} else {
					accumulated += (element.textContent ?? '').length;
				}
			}
		}
	}

	return { node: container, offset: container.childNodes.length };
}

function setCursorOffsetInContainer(container: HTMLElement, targetOffset: number): void {
	const position = findDomPosition(container, targetOffset);
	if (!position) {
		return;
	}

	const selection = globalThis.getSelection();
	if (!selection) {
		return;
	}

	const range = document.createRange();
	range.setStart(position.node, position.offset);
	range.collapse(true);
	selection.removeAllRanges();
	selection.addRange(range);
}

function createPillElement(path: string): HTMLButtonElement {
	const pill = document.createElement('button');
	pill.type = 'button';
	pill.setAttribute(PILL_ATTR, path);
	pill.setAttribute('aria-label', path);
	pill.contentEditable = 'false';
	pill.className = [
		FILE_REFERENCE_BASE_CLASS_NAME,
		FILE_REFERENCE_INTERACTIVE_CLASS_NAME,
		'mx-0.5 align-baseline border border-accent/25 select-none',
	].join(' ');

	// File icon (inline SVG for imperative DOM)
	const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	icon.setAttribute('width', '10');
	icon.setAttribute('height', '10');
	icon.setAttribute('viewBox', '0 0 24 24');
	icon.setAttribute('fill', 'none');
	icon.setAttribute('stroke', 'currentColor');
	icon.setAttribute('stroke-width', '2');
	icon.setAttribute('stroke-linecap', 'round');
	icon.setAttribute('stroke-linejoin', 'round');
	icon.setAttribute('class', 'shrink-0');
	const pathElement = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	pathElement.setAttribute('d', 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z');
	const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
	polyline.setAttribute('points', '14 2 14 8 20 8');
	icon.append(pathElement, polyline);

	const label = document.createElement('span');
	label.textContent = getFileName(path);
	label.className = `${FILE_REFERENCE_LABEL_CLASS_NAME} max-w-[120px]`;

	pill.append(icon, label);

	return pill;
}

function createPreviewElementPillElement(reference: PreviewElementReference, isMissing = false): HTMLButtonElement {
	const pill = document.createElement('button');
	pill.type = 'button';
	pill.setAttribute(PREVIEW_ELEMENT_REFERENCE_ATTR, serializePreviewElementReference(reference));
	pill.setAttribute('aria-label', getPreviewElementDisplayText(reference));
	pill.contentEditable = 'false';
	pill.className = [
		PREVIEW_REFERENCE_BASE_CLASS_NAME,
		isMissing ? PREVIEW_REFERENCE_MISSING_CLASS_NAME : '',
		PREVIEW_REFERENCE_INTERACTIVE_CLASS_NAME,
		'mx-0.5 align-baseline cursor-pointer select-none',
	].join(' ');

	const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	icon.setAttribute('width', '10');
	icon.setAttribute('height', '10');
	icon.setAttribute('viewBox', '0 0 24 24');
	icon.setAttribute('fill', 'none');
	icon.setAttribute('stroke', 'currentColor');
	icon.setAttribute('stroke-width', '2');
	icon.setAttribute('stroke-linecap', 'round');
	icon.setAttribute('stroke-linejoin', 'round');
	icon.setAttribute('class', PREVIEW_REFERENCE_ICON_CLASS_NAME);
	const pathOne = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	pathOne.setAttribute(
		'd',
		'm21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72',
	);
	const pathTwo = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	pathTwo.setAttribute('d', 'm14 7 3 3');
	const pathThree = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	pathThree.setAttribute('d', 'M5 6v4');
	const pathFour = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	pathFour.setAttribute('d', 'M19 14v4');
	const pathFive = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	pathFive.setAttribute('d', 'M10 2v2');
	const pathSix = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	pathSix.setAttribute('d', 'M7 8H3');
	const pathSeven = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	pathSeven.setAttribute('d', 'M21 16h-4');
	const pathEight = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	pathEight.setAttribute('d', 'M11 3H9');
	icon.append(pathOne, pathTwo, pathThree, pathFour, pathFive, pathSix, pathSeven, pathEight);

	const textRow = document.createElement('span');
	textRow.className = PREVIEW_REFERENCE_TEXT_ROW_CLASS_NAME;

	const label = document.createElement('span');
	label.textContent = getPreviewElementLabel(reference.tagName);
	label.className = PREVIEW_REFERENCE_LABEL_CLASS_NAME;
	textRow.append(label);

	const summary = getPreviewElementSummary(reference);
	if (summary) {
		const summaryElement = document.createElement('span');
		summaryElement.textContent = summary;
		summaryElement.className = PREVIEW_REFERENCE_SUMMARY_CLASS_NAME;
		textRow.append(summaryElement);
	}

	pill.append(icon, textRow);

	return pill;
}

export function RichTextInput({
	ref,
	segments,
	onSegmentsChange,
	onKeyDown,
	onCursorChange,
	onPasteFiles,
	placeholder,
	disabled,
	inlineSuffix,
	className,
}: {
	ref?: React.Ref<RichTextInputHandle>;
	segments: InputSegment[];
	onSegmentsChange: (segments: InputSegment[]) => void;
	onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
	onCursorChange?: (offset: number) => void;
	onPasteFiles?: (files: File[]) => void;
	placeholder?: string;
	disabled?: boolean;
	inlineSuffix?: React.ReactNode;
	className?: string;
}) {
	const inputId = useId();
	const containerReference = useRef<HTMLDivElement>(null);
	const isComposingReference = useRef(false);
	const suppressInputReference = useRef(false);
	const lastRenderedSegmentsReference = useRef<InputSegment[]>([]);
	const lastCursorOffsetReference = useRef(0);
	const hoveredPreviewElementKeyReference = useRef<string | undefined>(undefined);
	const [missingPreviewElementReferenceKeys, setMissingPreviewElementReferenceKeys] = useState<ReadonlySet<string>>(() => new Set());
	const activePreviewElementReferenceKeys = useMemo(
		() =>
			new Set(
				segments
					.filter((segment): segment is PreviewElementSegment => segment.type === 'preview-element')
					.map((segment) => getPreviewElementReferenceKey(segment)),
			),
		[segments],
	);
	const activeMissingPreviewElementReferenceKeys = useMemo(() => {
		const nextKeys = new Set(
			[...missingPreviewElementReferenceKeys].filter((referenceKey) => activePreviewElementReferenceKeys.has(referenceKey)),
		);

		return areSetsEqual(missingPreviewElementReferenceKeys, nextKeys) ? missingPreviewElementReferenceKeys : nextKeys;
	}, [activePreviewElementReferenceKeys, missingPreviewElementReferenceKeys]);
	const openFileTarget = useFileTargetOpener();
	const { activateReference, clearReferenceHighlight, hoverReference } = usePreviewReferenceInteractions();

	const updatePreviewReferenceAvailability = useCallback((reference: PreviewElementReference, found: boolean) => {
		const referenceKey = getPreviewElementReferenceKey(reference);
		setMissingPreviewElementReferenceKeys((currentKeys) => {
			const isMissing = currentKeys.has(referenceKey);
			if (!found) {
				if (isMissing) {
					return currentKeys;
				}

				const nextKeys = new Set(currentKeys);
				nextKeys.add(referenceKey);
				return nextKeys;
			}

			if (!isMissing) {
				return currentKeys;
			}

			const nextKeys = new Set(currentKeys);
			nextKeys.delete(referenceKey);
			return nextKeys;
		});
	}, []);

	// Persistent DOM node used as a portal target for inlineSuffix.
	// Created once via lazy useState initializer and re-appended after
	// each renderSegments call (since textContent='' removes it from the tree).
	const [suffixAnchor] = useState(() => {
		const span = document.createElement('span');
		span.contentEditable = 'false';
		span.style.userSelect = 'none';
		span.className = 'inline-flex items-end align-baseline';
		return span;
	});

	// Stable refs for callbacks used in insertMention
	const onSegmentsChangeReference = useRef(onSegmentsChange);
	const onCursorChangeReference = useRef(onCursorChange);
	useEffect(() => {
		onSegmentsChangeReference.current = onSegmentsChange;
		onCursorChangeReference.current = onCursorChange;
	}, [onSegmentsChange, onCursorChange]);

	// Render segments into the DOM
	const renderSegments = useCallback(() => {
		const container = containerReference.current;
		if (!container) return;

		const cursorOffset = getCursorOffsetInContainer(container);
		normalizeContainerDom(container);

		suppressInputReference.current = true;
		container.textContent = '';

		for (const segment of segments) {
			if (segment.type === 'text') {
				const parts = segment.value.split('\n');
				for (const [index, part] of parts.entries()) {
					if (index > 0) {
						container.append(document.createElement('br'));
					}
					if (part) {
						container.append(document.createTextNode(part));
					}
				}
			} else if (segment.type === 'mention') {
				container.append(createPillElement(segment.path));
			} else {
				container.append(
					createPreviewElementPillElement(segment, activeMissingPreviewElementReferenceKeys.has(getPreviewElementReferenceKey(segment))),
				);
			}
		}

		// Restore cursor
		if (cursorOffset >= 0) {
			lastCursorOffsetReference.current = cursorOffset;
			setCursorOffsetInContainer(container, cursorOffset);
		}

		// Append inline suffix anchor at the end of content
		if (inlineSuffix) {
			container.append(suffixAnchor);
			// Auto-scroll to keep the latest content visible
			container.scrollTop = container.scrollHeight;
		}

		suppressInputReference.current = false;
	}, [activeMissingPreviewElementReferenceKeys, inlineSuffix, segments, suffixAnchor]);

	// Expose imperative handle
	useImperativeHandle(ref, () => ({
		focus() {
			containerReference.current?.focus();
		},
		setCursorPosition(offset: number) {
			const container = containerReference.current;
			if (!container) return;
			normalizeContainerDom(container);

			const maxOffset = getSegmentsTextLength(segments);
			const nextOffset = Math.max(0, Math.min(offset, maxOffset));
			lastCursorOffsetReference.current = nextOffset;
			setCursorOffsetInContainer(container, nextOffset);
		},
		moveCursorToEnd() {
			const container = containerReference.current;
			if (!container) return;
			normalizeContainerDom(container);

			const maxOffset = getSegmentsTextLength(segments);
			lastCursorOffsetReference.current = maxOffset;
			setCursorOffsetInContainer(container, maxOffset);
		},
		insertMention(path: string, triggerOffset: number, queryLength: number) {
			const container = containerReference.current;
			if (!container) return;

			const plainText = segmentsToPlainText(parseSegmentsFromDom(container));
			const before = plainText.slice(0, triggerOffset);
			const after = plainText.slice(triggerOffset + 1 + queryLength);

			const newSegments: InputSegment[] = [];
			if (before) {
				newSegments.push({ type: 'text', value: before });
			}
			newSegments.push({ type: 'mention', path }, { type: 'text', value: ` ${after}` });

			lastRenderedSegmentsReference.current = newSegments;
			onSegmentsChangeReference.current(newSegments);

			requestAnimationFrame(() => {
				const liveContainer = containerReference.current;
				if (!liveContainer) return;

				// Rebuild DOM
				suppressInputReference.current = true;
				liveContainer.textContent = '';
				for (const segment of newSegments) {
					if (segment.type === 'text') {
						const parts = segment.value.split('\n');
						for (const [index, part] of parts.entries()) {
							if (index > 0) {
								liveContainer.append(document.createElement('br'));
							}
							if (part) {
								liveContainer.append(document.createTextNode(part));
							}
						}
					} else if (segment.type === 'mention') {
						liveContainer.append(createPillElement(segment.path));
					} else {
						liveContainer.append(
							createPreviewElementPillElement(
								segment,
								activeMissingPreviewElementReferenceKeys.has(getPreviewElementReferenceKey(segment)),
							),
						);
					}
				}
				suppressInputReference.current = false;

				// Place cursor after the pill + space
				const newOffset = before.length + 1 + path.length + 1;
				lastCursorOffsetReference.current = newOffset;
				setCursorOffsetInContainer(liveContainer, newOffset);
				liveContainer.focus();

				onCursorChangeReference.current?.(newOffset);
			});
		},
		getPlainText() {
			return segmentsToPlainText(segments);
		},
		clear() {
			const container = containerReference.current;
			if (container) {
				container.textContent = '';
			}
			onSegmentsChangeReference.current([]);
		},
	}));

	// Re-render DOM when segments identity changes
	useEffect(() => {
		if (lastRenderedSegmentsReference.current !== segments) {
			lastRenderedSegmentsReference.current = segments;
			renderSegments();
		}
	}, [segments, renderSegments]);

	useEffect(() => {
		renderSegments();
	}, [renderSegments]);

	useEffect(() => {
		const previewReferences = segments.filter((segment): segment is PreviewElementSegment => segment.type === 'preview-element');
		const previewReferenceKeys = new Set(previewReferences.map((reference) => getPreviewElementReferenceKey(reference)));

		if (previewReferences.length === 0) {
			return;
		}

		const uniquePreviewReferences = [
			...new Map(previewReferences.map((reference) => [getPreviewElementReferenceKey(reference), reference])).values(),
		];
		let isCancelled = false;

		void Promise.all(uniquePreviewReferences.map(async (reference) => ({ reference, found: await resolvePreviewElement(reference) }))).then(
			(results) => {
				if (isCancelled) {
					return;
				}

				setMissingPreviewElementReferenceKeys((currentKeys) => {
					const nextKeys = new Set([...currentKeys].filter((key) => previewReferenceKeys.has(key)));
					let didChange = !areSetsEqual(currentKeys, nextKeys);

					for (const { reference, found } of results) {
						if (found === undefined) {
							continue;
						}

						const referenceKey = getPreviewElementReferenceKey(reference);
						if (!found) {
							if (!nextKeys.has(referenceKey)) {
								nextKeys.add(referenceKey);
								didChange = true;
							}
							continue;
						}

						if (nextKeys.delete(referenceKey)) {
							didChange = true;
						}
					}

					return didChange ? nextKeys : currentKeys;
				});
			},
		);

		return () => {
			isCancelled = true;
		};
	}, [segments]);

	// Handle input events — re-parse DOM into segments
	const handleInput = useCallback(() => {
		if (suppressInputReference.current || isComposingReference.current) return;
		const container = containerReference.current;
		if (!container) return;
		normalizeContainerDom(container);

		const newSegments = normalizeSegments(parseSegmentsFromDom(container));
		lastRenderedSegmentsReference.current = newSegments;
		onSegmentsChange(newSegments);

		if (onCursorChange) {
			const offset = getCursorOffsetInContainer(container);
			lastCursorOffsetReference.current = Math.max(0, offset);
			onCursorChange(offset);
		}
	}, [onSegmentsChange, onCursorChange]);

	// Track cursor on selection changes
	const handleSelect = useCallback(() => {
		if (!onCursorChange) return;
		const container = containerReference.current;
		if (!container) return;
		const offset = getCursorOffsetInContainer(container);
		normalizeContainerDom(container);
		if (offset >= 0) {
			lastCursorOffsetReference.current = offset;
			onCursorChange(offset);
		}
	}, [onCursorChange]);

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLDivElement>) => {
			const target = event.target instanceof HTMLElement ? event.target : undefined;
			const fileReferenceElement = target?.closest<HTMLElement>(`[${PILL_ATTR}]`);
			if (fileReferenceElement && target !== containerReference.current) {
				const path = fileReferenceElement.getAttribute(PILL_ATTR);
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					if (path) {
						openFileTarget({ path });
					}
				}
				return;
			}

			const previewReferenceElement = target?.closest<HTMLElement>(`[${PREVIEW_ELEMENT_REFERENCE_ATTR}]`);
			const previewReference = deserializePreviewElementReference(
				previewReferenceElement?.getAttribute(PREVIEW_ELEMENT_REFERENCE_ATTR) ?? '',
			);
			if (previewReference && target !== containerReference.current) {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					activateReference(previewReference, (found) => {
						updatePreviewReferenceAvailability(previewReference, found);
					});
				}
				return;
			}

			const container = containerReference.current;
			if (container && (event.key === 'Backspace' || event.key === 'Delete') && !event.defaultPrevented && !event.nativeEvent.isComposing) {
				const selection = globalThis.getSelection();
				if (!selection || selection.isCollapsed) {
					const cursorOffset = selection?.rangeCount
						? Math.max(getCursorOffsetInContainer(container), lastCursorOffsetReference.current)
						: lastCursorOffsetReference.current;
					normalizeContainerDom(container);
					const removableSegmentIndex = getAdjacentRemovableSegmentIndex(
						segments,
						cursorOffset,
						event.key === 'Backspace' ? 'backward' : 'forward',
					);

					if (removableSegmentIndex !== undefined) {
						event.preventDefault();
						const nextSegments = segments.filter((_, index) => index !== removableSegmentIndex);
						const nextCursorOffset = getSegmentStartOffset(segments, removableSegmentIndex);

						lastRenderedSegmentsReference.current = nextSegments;
						onSegmentsChange(nextSegments);

						requestAnimationFrame(() => {
							const liveContainer = containerReference.current;
							if (!liveContainer) return;

							lastCursorOffsetReference.current = nextCursorOffset;
							setCursorOffsetInContainer(liveContainer, nextCursorOffset);
							onCursorChange?.(nextCursorOffset);
						});
					}
				}
			}

			onKeyDown?.(event);
		},
		[activateReference, onCursorChange, onKeyDown, onSegmentsChange, openFileTarget, segments, updatePreviewReferenceAvailability],
	);

	const handlePaste = useCallback(
		(event: React.ClipboardEvent<HTMLDivElement>) => {
			const imageFiles = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'));
			if (imageFiles.length > 0 && onPasteFiles) {
				event.preventDefault();
				onPasteFiles(imageFiles);
				return;
			}

			event.preventDefault();
			const text = event.clipboardData.getData('text/plain');
			if (text) {
				document.execCommand('insertText', false, text);
			}
		},
		[onPasteFiles],
	);

	const handleMouseMove = useCallback(
		(event: React.MouseEvent<HTMLDivElement>) => {
			const target =
				event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(`[${PREVIEW_ELEMENT_REFERENCE_ATTR}]`) : undefined;
			const reference = deserializePreviewElementReference(target?.getAttribute(PREVIEW_ELEMENT_REFERENCE_ATTR) ?? '');
			const referenceKey = reference ? getPreviewElementReferenceKey(reference) : undefined;

			if (referenceKey === hoveredPreviewElementKeyReference.current) {
				return;
			}

			hoveredPreviewElementKeyReference.current = referenceKey;
			if (!reference || (referenceKey !== undefined && activeMissingPreviewElementReferenceKeys.has(referenceKey))) {
				clearReferenceHighlight();
				return;
			}

			hoverReference(reference);
		},
		[activeMissingPreviewElementReferenceKeys, clearReferenceHighlight, hoverReference],
	);

	const handleMouseLeave = useCallback(() => {
		hoveredPreviewElementKeyReference.current = undefined;
		clearReferenceHighlight();
	}, [clearReferenceHighlight]);

	const handleClick = useCallback(
		(event: React.MouseEvent<HTMLDivElement>) => {
			const target = event.target instanceof HTMLElement ? event.target : undefined;
			const fileReferenceElement = target?.closest<HTMLElement>(`[${PILL_ATTR}]`);
			if (fileReferenceElement) {
				const path = fileReferenceElement.getAttribute(PILL_ATTR);
				event.preventDefault();
				if (path) {
					openFileTarget({ path });
				}
				return;
			}

			const previewReferenceElement = target?.closest<HTMLElement>(`[${PREVIEW_ELEMENT_REFERENCE_ATTR}]`);
			const previewReference = deserializePreviewElementReference(
				previewReferenceElement?.getAttribute(PREVIEW_ELEMENT_REFERENCE_ATTR) ?? '',
			);
			if (previewReference) {
				event.preventDefault();
				activateReference(previewReference, (found) => {
					updatePreviewReferenceAvailability(previewReference, found);
				});
				return;
			}

			handleSelect();
		},
		[activateReference, handleSelect, openFileTarget, updatePreviewReferenceAvailability],
	);

	const isEmpty = segments.length === 0 || (segments.length === 1 && segments[0].type === 'text' && !segments[0].value);

	return (
		<div className="relative">
			<AnimatePresence>
				{isEmpty && !disabled && placeholder && (
					<motion.div
						key={placeholder}
						initial={{ opacity: 0, y: 2 }}
						animate={{ opacity: 1, y: 0, transition: { duration: 0.15 } }}
						exit={{ opacity: 0, transition: { duration: 0.05 } }}
						className="
							pointer-events-none absolute inset-0 truncate px-2.5 pt-2 text-sm/relaxed
							text-text-secondary
						"
					>
						{placeholder}
					</motion.div>
				)}
			</AnimatePresence>
			<div
				ref={containerReference}
				id={`agent-message-${inputId}`}
				contentEditable={!disabled}
				suppressContentEditableWarning
				onInput={handleInput}
				onKeyDown={handleKeyDown}
				onSelect={handleSelect}
				onClick={handleClick}
				onCompositionStart={() => {
					isComposingReference.current = true;
				}}
				onCompositionEnd={() => {
					isComposingReference.current = false;
					handleInput();
				}}
				onPaste={handlePaste}
				onMouseMove={handleMouseMove}
				onMouseLeave={handleMouseLeave}
				role="textbox"
				aria-label="Message"
				aria-multiline="true"
				aria-placeholder={placeholder}
				className={cn(
					`
						block max-h-32 min-h-[3em] w-full overflow-y-auto bg-transparent px-2.5
						pt-2 pb-0
					`,
					'text-sm/relaxed text-text-primary',
					`
						focus:outline-none
						focus-visible:outline-none
					`,
					disabled && 'pointer-events-none opacity-50',
					className,
				)}
			/>
			{inlineSuffix && createPortal(inlineSuffix, suffixAnchor)}
		</div>
	);
}
