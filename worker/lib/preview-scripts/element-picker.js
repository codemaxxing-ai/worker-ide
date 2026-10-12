(function () {
	var ideOrigin = window.__PREVIEW_CONFIG && window.__PREVIEW_CONFIG.ideOrigin;
	if (typeof ideOrigin !== 'string' || ideOrigin === '*') return;
	var isEmbedded = window.parent !== window;
	if (!isEmbedded) {
		return;
	}

	var pickerActive = false;
	var pickerTarget = null;
	var highlightedTarget = null;
	var stickyHighlightActive = false;
	var overlayRoot;
	var backdrop;
	var frame;
	var label;
	var cursorStyle;
	var MAX_REFERENCE_TEXT_LENGTH = 160;
	var MAX_CLASS_NAME_LENGTH = 120;
	var MAX_LOCATOR_CANDIDATES = 6;
	var SAFE_ATTRIBUTE_NAMES = ['id', 'name', 'alt', 'title', 'placeholder', 'type', 'href', 'src'];

	function applyStyles(element, styles) {
		for (var key in styles) {
			element.style[key] = styles[key];
		}
	}

	function ensureOverlay() {
		if (overlayRoot) {
			return;
		}

		overlayRoot = document.createElement('div');
		applyStyles(overlayRoot, {
			position: 'fixed',
			inset: '0',
			zIndex: '2147483646',
			pointerEvents: 'none',
			fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
		});

		backdrop = document.createElement('div');
		applyStyles(backdrop, {
			position: 'absolute',
			inset: '0',
			opacity: '0',
			transition: 'opacity 140ms ease-out',
			background:
				'linear-gradient(135deg, rgba(244,114,182,0.12) 0%, rgba(168,85,247,0.1) 28%, rgba(59,130,246,0.1) 58%, rgba(45,212,191,0.08) 100%), radial-gradient(circle at top left, rgba(244,114,182,0.14) 0%, rgba(244,114,182,0) 38%), radial-gradient(circle at top right, rgba(59,130,246,0.12) 0%, rgba(59,130,246,0) 42%), radial-gradient(circle at bottom center, rgba(45,212,191,0.1) 0%, rgba(45,212,191,0) 44%), rgba(15,23,42,0.16)',
		});

		frame = document.createElement('div');
		applyStyles(frame, {
			position: 'fixed',
			boxSizing: 'border-box',
			borderRadius: '18px',
			border: '2px solid rgba(255,255,255,0.95)',
			boxShadow: '0 0 0 1px rgba(244,114,182,0.25), 0 0 0 4px rgba(168,85,247,0.2), 0 12px 30px rgba(15,23,42,0.35)',
			background: 'linear-gradient(135deg, rgba(244,114,182,0.08), rgba(168,85,247,0.04), rgba(59,130,246,0.08))',
			transition: 'transform 100ms ease-out, opacity 120ms ease-out, width 120ms ease-out, height 120ms ease-out',
			transform: 'translate3d(0, 0, 0)',
			opacity: '0',
		});

		label = document.createElement('div');
		applyStyles(label, {
			position: 'fixed',
			display: 'inline-flex',
			alignItems: 'center',
			padding: '4px 8px',
			borderRadius: '9999px',
			border: '1px solid rgba(255,255,255,0.28)',
			background: 'rgba(15, 23, 42, 0.88)',
			color: '#f8fafc',
			fontSize: '11px',
			fontWeight: '700',
			letterSpacing: '0.01em',
			boxShadow: '0 8px 18px rgba(15,23,42,0.22)',
			opacity: '0',
			transform: 'translate3d(0, 0, 0)',
			maxWidth: 'min(180px, calc(100vw - 16px))',
			whiteSpace: 'nowrap',
			overflow: 'hidden',
			textOverflow: 'ellipsis',
		});

		cursorStyle = document.createElement('style');
		cursorStyle.textContent = 'html, body, body * { cursor: crosshair !important; }';

		overlayRoot.append(backdrop, frame, label);
		(document.body || document.documentElement).appendChild(overlayRoot);
	}

	function setPickerCursor(isActive) {
		ensureOverlay();
		if (!cursorStyle) {
			return;
		}

		if (isActive) {
			if (!cursorStyle.isConnected) {
				(document.head || document.documentElement).appendChild(cursorStyle);
			}
			return;
		}

		cursorStyle.remove();
	}

	function escapeSelectorValue(value) {
		if (window.CSS && typeof window.CSS.escape === 'function') {
			return window.CSS.escape(value);
		}
		return value.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
	}

	function isUniqueSelector(selector) {
		try {
			return document.querySelectorAll(selector).length === 1;
		} catch {
			return false;
		}
	}

	function createAttributeSelector(element, attributeName) {
		var rawValue = element.getAttribute(attributeName);
		if (!rawValue) {
			return undefined;
		}

		var tagName = element.tagName.toLowerCase();
		var selector = tagName + '[' + attributeName + '="' + rawValue.replaceAll('"', '\\"') + '"]';
		return isUniqueSelector(selector) ? selector : undefined;
	}

	function createClassSelector(element) {
		if (!element.classList || element.classList.length === 0) {
			return undefined;
		}

		var classes = [];
		for (var classIndex = 0; classIndex < element.classList.length && classes.length < 3; classIndex++) {
			var className = element.classList.item(classIndex);
			if (!className) {
				continue;
			}
			classes.push('.' + escapeSelectorValue(className));
		}

		if (classes.length === 0) {
			return undefined;
		}

		var selector = element.tagName.toLowerCase() + classes.join('');
		return isUniqueSelector(selector) ? selector : undefined;
	}

	function collapseWhitespace(value) {
		return value.replaceAll(/\s+/g, ' ').trim();
	}

	function clipText(value, maxLength) {
		if (!value) {
			return undefined;
		}

		var normalized = collapseWhitespace(value);
		if (!normalized) {
			return undefined;
		}

		return normalized.length > maxLength ? normalized.slice(0, maxLength).trimEnd() : normalized;
	}

	function sanitizeUrlHint(value) {
		if (!value) {
			return undefined;
		}

		try {
			var parsed = new URL(value, window.location.href);
			var path = clipText(parsed.pathname, MAX_REFERENCE_TEXT_LENGTH);
			if (!path) {
				return undefined;
			}

			return parsed.origin === window.location.origin ? path : parsed.origin + path;
		} catch {
			var stripped = value.split(/[?#]/u, 1)[0];
			return clipText(stripped, MAX_REFERENCE_TEXT_LENGTH);
		}
	}

	function getAttributeHint(element, attributeName) {
		var rawValue = element.getAttribute(attributeName);
		if (!rawValue) {
			return undefined;
		}

		if (attributeName === 'href' || attributeName === 'src') {
			return sanitizeUrlHint(rawValue);
		}

		return clipText(rawValue, MAX_REFERENCE_TEXT_LENGTH);
	}

	function getElementTextPreview(element) {
		var tagName = element.tagName.toLowerCase();
		if (tagName === 'input' || tagName === 'textarea' || tagName === 'select' || tagName === 'option') {
			return undefined;
		}

		return clipText(element.innerText || element.textContent || '', MAX_REFERENCE_TEXT_LENGTH);
	}

	function getLabelledByText(element) {
		var labelledBy = element.getAttribute('aria-labelledby');
		if (!labelledBy) {
			return undefined;
		}

		var parts = [];
		for (var idIndex = 0; idIndex < labelledBy.split(/\s+/).length; idIndex++) {
			var id = labelledBy.split(/\s+/)[idIndex];
			if (!id) {
				continue;
			}

			var labelledElement = document.getElementById(id);
			var text = labelledElement ? getElementTextPreview(labelledElement) : undefined;
			if (text) {
				parts.push(text);
			}
		}

		return parts.length > 0 ? clipText(parts.join(' '), MAX_REFERENCE_TEXT_LENGTH) : undefined;
	}

	function getAccessibleName(element) {
		return (
			clipText(element.getAttribute('aria-label') || '', MAX_REFERENCE_TEXT_LENGTH) ||
			getLabelledByText(element) ||
			clipText(element.getAttribute('alt') || '', MAX_REFERENCE_TEXT_LENGTH) ||
			clipText(element.getAttribute('title') || '', MAX_REFERENCE_TEXT_LENGTH) ||
			clipText(element.getAttribute('placeholder') || '', MAX_REFERENCE_TEXT_LENGTH) ||
			(element.tagName.toLowerCase() === 'button' || element.tagName.toLowerCase() === 'a' ? getElementTextPreview(element) : undefined)
		);
	}

	function getElementRole(element) {
		var explicitRole = clipText(element.getAttribute('role') || '', 40);
		if (explicitRole) {
			return explicitRole;
		}

		var tagName = element.tagName.toLowerCase();
		if (tagName === 'button') {
			return 'button';
		}
		if (tagName === 'a' && element.hasAttribute('href')) {
			return 'link';
		}
		if (tagName === 'img') {
			return 'img';
		}
		if (tagName === 'textarea') {
			return 'textbox';
		}
		if (tagName === 'input') {
			var inputType = (element.getAttribute('type') || 'text').toLowerCase();
			if (inputType === 'button' || inputType === 'submit' || inputType === 'reset') {
				return 'button';
			}
			if (inputType === 'checkbox' || inputType === 'radio') {
				return inputType;
			}
			return 'textbox';
		}

		return undefined;
	}

	function getClassNameSummary(element) {
		if (!element.classList || element.classList.length === 0) {
			return undefined;
		}

		var classes = [];
		for (var classIndex = 0; classIndex < element.classList.length && classes.length < 4; classIndex++) {
			var className = element.classList.item(classIndex);
			if (!className) {
				continue;
			}
			classes.push(className);
		}

		return clipText(classes.join(' '), MAX_CLASS_NAME_LENGTH);
	}

	function getAttributeHints(element) {
		var attributes = {};
		for (var attributeIndex = 0; attributeIndex < SAFE_ATTRIBUTE_NAMES.length; attributeIndex++) {
			var attributeName = SAFE_ATTRIBUTE_NAMES[attributeIndex];
			var value = getAttributeHint(element, attributeName);
			if (value) {
				attributes[attributeName] = value;
			}
		}

		return Object.keys(attributes).length > 0 ? attributes : undefined;
	}

	function getContainerSelector(element) {
		var current = element.parentElement;
		while (current && current !== document.body) {
			var stableSelector = getStableSelectorForElement(current) || createClassSelector(current);
			if (stableSelector) {
				return stableSelector;
			}
			current = current.parentElement;
		}

		return undefined;
	}

	function buildLocatorCandidates(element, primarySelector) {
		var candidates = [];
		var seen = new Set();

		function pushCandidate(candidate) {
			if (!candidate || candidate === primarySelector || seen.has(candidate)) {
				return;
			}
			seen.add(candidate);
			candidates.push(candidate);
		}

		pushCandidate(getStableSelectorForElement(element));
		pushCandidate(createClassSelector(element));

		var attributeSelectors = ['title', 'placeholder', 'href', 'src'];
		for (var attributeIndex = 0; attributeIndex < attributeSelectors.length; attributeIndex++) {
			pushCandidate(createAttributeSelector(element, attributeSelectors[attributeIndex]));
		}

		return candidates.slice(0, MAX_LOCATOR_CANDIDATES);
	}

	function getStableSelectorForElement(element) {
		if (element.id) {
			var idSelector = '#' + escapeSelectorValue(element.id);
			if (isUniqueSelector(idSelector)) {
				return idSelector;
			}
		}

		var attributeSelectors = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'aria-label', 'name', 'alt', 'title', 'placeholder'];
		for (var attributeIndex = 0; attributeIndex < attributeSelectors.length; attributeIndex++) {
			var attributeSelector = createAttributeSelector(element, attributeSelectors[attributeIndex]);
			if (attributeSelector) {
				return attributeSelector;
			}
		}

		var classSelector = createClassSelector(element);
		if (classSelector) {
			return classSelector;
		}

		return undefined;
	}

	function getStructuralSelector(element) {
		var currentTagName = element.tagName.toLowerCase();
		var siblingIndex = 1;
		var sibling = element.previousElementSibling;
		while (sibling) {
			if (sibling.tagName === element.tagName) {
				siblingIndex += 1;
			}
			sibling = sibling.previousElementSibling;
		}
		return currentTagName + ':nth-of-type(' + siblingIndex + ')';
	}

	function buildElementSelector(element) {
		if (element === document.body) {
			return 'body';
		}

		var stableSelector = getStableSelectorForElement(element);
		if (stableSelector) {
			return stableSelector;
		}

		var path = [];
		var current = element;
		while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
			path.unshift(getStructuralSelector(current));

			var currentStableSelector = getStableSelectorForElement(current);
			if (currentStableSelector) {
				var anchoredSelector = currentStableSelector;
				if (path.length > 1) {
					anchoredSelector += ' > ' + path.slice(1).join(' > ');
				}
				if (isUniqueSelector(anchoredSelector)) {
					return anchoredSelector;
				}
			}

			var candidate = 'body > ' + path.join(' > ');
			if (isUniqueSelector(candidate)) {
				return candidate;
			}
			current = current.parentElement;
		}

		return path.length > 0 ? 'body > ' + path.join(' > ') : 'body';
	}

	function resolveCandidateTarget(node) {
		var element = node instanceof Element ? node : undefined;
		while (element && element !== overlayRoot) {
			var tagName = element.tagName.toLowerCase();
			if (
				tagName !== 'html' &&
				tagName !== 'script' &&
				tagName !== 'style' &&
				tagName !== 'link' &&
				tagName !== 'meta' &&
				tagName !== 'br'
			) {
				return element;
			}
			element = element.parentElement;
		}

		return document.body;
	}

	function normalizePickedTarget(element) {
		var current = element;
		while (current && current !== document.body) {
			var tagName = current.tagName.toLowerCase();
			if (
				tagName === 'button' ||
				tagName === 'a' ||
				tagName === 'label' ||
				tagName === 'summary' ||
				tagName === 'input' ||
				tagName === 'textarea' ||
				tagName === 'select' ||
				tagName === 'option' ||
				tagName === 'img'
			) {
				return current;
			}

			if (tagName === 'svg' || tagName === 'path' || tagName === 'circle' || tagName === 'rect' || tagName === 'use') {
				var interactiveAncestor = current.closest('button, a, label');
				if (interactiveAncestor) {
					return interactiveAncestor;
				}
			}

			current = current.parentElement;
		}

		return element;
	}

	function getElementFromPoint(x, y) {
		var target = document.elementFromPoint(x, y);
		return normalizePickedTarget(resolveCandidateTarget(target));
	}

	function getActiveTarget() {
		return pickerActive ? pickerTarget : highlightedTarget;
	}

	function buildPreviewElementReference(element) {
		var primarySelector = buildElementSelector(element);
		return {
			tagName: element.tagName.toLowerCase(),
			primarySelector: primarySelector,
			locatorCandidates: buildLocatorCandidates(element, primarySelector),
			containerSelector: getContainerSelector(element),
			textPreview: getElementTextPreview(element),
			accessibleName: getAccessibleName(element),
			role: getElementRole(element),
			className: getClassNameSummary(element),
			attributes: getAttributeHints(element),
		};
	}

	function scoreReferenceMatch(element, reference) {
		if (!element || !reference || element.tagName.toLowerCase() !== reference.tagName) {
			return -1;
		}

		var score = 10;
		var textPreview = getElementTextPreview(element);
		if (reference.textPreview && textPreview === reference.textPreview) {
			score += 50;
		} else if (
			reference.textPreview &&
			textPreview &&
			(textPreview.indexOf(reference.textPreview) >= 0 || reference.textPreview.indexOf(textPreview) >= 0)
		) {
			score += 30;
		}

		var accessibleName = getAccessibleName(element);
		if (reference.accessibleName && accessibleName === reference.accessibleName) {
			score += 60;
		} else if (
			reference.accessibleName &&
			accessibleName &&
			(accessibleName.indexOf(reference.accessibleName) >= 0 || reference.accessibleName.indexOf(accessibleName) >= 0)
		) {
			score += 35;
		}

		if (reference.role && getElementRole(element) === reference.role) {
			score += 20;
		}

		if (reference.className && getClassNameSummary(element) === reference.className) {
			score += 20;
		}

		if (reference.attributes) {
			for (var attributeIndex = 0; attributeIndex < SAFE_ATTRIBUTE_NAMES.length; attributeIndex++) {
				var attributeName = SAFE_ATTRIBUTE_NAMES[attributeIndex];
				if (!reference.attributes[attributeName]) {
					continue;
				}

				if (getAttributeHint(element, attributeName) === reference.attributes[attributeName]) {
					score += attributeName === 'id' ? 50 : 18;
				}
			}
		}

		return score;
	}

	function findBestReferenceCandidate(reference, scopeRoot) {
		var candidates;
		try {
			candidates = (scopeRoot || document).querySelectorAll(reference.tagName);
		} catch {
			return null;
		}

		var bestElement = null;
		var bestScore = -1;
		var nextBestScore = -1;
		for (var candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
			var candidate = candidates[candidateIndex];
			var score = scoreReferenceMatch(candidate, reference);
			if (score > bestScore) {
				nextBestScore = bestScore;
				bestScore = score;
				bestElement = candidate;
			} else if (score > nextBestScore) {
				nextBestScore = score;
			}
		}

		if (!bestElement || bestScore < 40 || bestScore - nextBestScore < 10) {
			return null;
		}

		return bestElement;
	}

	function findElementByReference(reference) {
		try {
			if (
				!reference ||
				typeof reference !== 'object' ||
				typeof reference.primarySelector !== 'string' ||
				typeof reference.tagName !== 'string'
			) {
				return null;
			}

			var selectors = [reference.primarySelector].concat(Array.isArray(reference.locatorCandidates) ? reference.locatorCandidates : []);
			for (var selectorIndex = 0; selectorIndex < selectors.length; selectorIndex++) {
				var selector = selectors[selectorIndex];
				if (typeof selector !== 'string' || !selector) {
					continue;
				}

				var matchedElement = document.querySelector(selector);
				var resolvedElement = matchedElement ? resolveCandidateTarget(matchedElement) : null;
				if (resolvedElement && scoreReferenceMatch(resolvedElement, reference) >= 40) {
					return resolvedElement;
				}
			}

			var containerElement =
				typeof reference.containerSelector === 'string' && reference.containerSelector
					? document.querySelector(reference.containerSelector)
					: null;
			return findBestReferenceCandidate(reference, containerElement) || findBestReferenceCandidate(reference, document);
		} catch {
			return null;
		}
	}

	function renderOverlay() {
		ensureOverlay();
		setPickerCursor(pickerActive);

		var viewportPadding = 6;
		var framePadding = 6;

		backdrop.style.opacity = pickerActive ? '1' : '0';

		var target = getActiveTarget();
		if (!target || !document.contains(target)) {
			frame.style.opacity = '0';
			label.style.opacity = '0';
			return;
		}

		var rect = target.getBoundingClientRect();
		var frameLeft = rect.left - framePadding;
		var frameTop = rect.top - framePadding;
		var frameWidth = Math.max(rect.right - rect.left + framePadding * 2, 24);
		var frameHeight = Math.max(rect.bottom - rect.top + framePadding * 2, 24);
		var frameRight = frameLeft + frameWidth;
		var frameBottom = frameTop + frameHeight;
		var frameEnclosesViewport = frameLeft <= 0 && frameTop <= 0 && frameRight >= window.innerWidth && frameBottom >= window.innerHeight;

		frame.style.opacity = '1';
		frame.style.left = frameLeft + 'px';
		frame.style.top = frameTop + 'px';
		frame.style.width = frameWidth + 'px';
		frame.style.height = frameHeight + 'px';

		label.textContent = '<' + target.tagName.toLowerCase() + '>';
		label.style.opacity = '1';

		var labelWidth = label.offsetWidth;
		var labelHeight = label.offsetHeight;
		var labelLeft;
		var labelTop;
		if (frameEnclosesViewport) {
			labelLeft = Math.min(viewportPadding + 8, window.innerWidth - viewportPadding - labelWidth);
			labelTop = Math.min(viewportPadding + 8, window.innerHeight - viewportPadding - labelHeight);
		} else {
			labelLeft = Math.min(Math.max(frameLeft + 8, viewportPadding), window.innerWidth - viewportPadding - labelWidth);
			labelTop = frameTop > labelHeight + 14 ? frameTop - labelHeight - 8 : frameBottom + 8;
			labelTop = Math.min(Math.max(labelTop, viewportPadding), window.innerHeight - viewportPadding - labelHeight);
		}

		label.style.left = labelLeft + 'px';
		label.style.top = labelTop + 'px';
	}

	function setPickerTargetFromPoint(x, y) {
		pickerTarget = getElementFromPoint(x, y);
		renderOverlay();
	}

	function cancelPicker(notifyParent) {
		pickerActive = false;
		pickerTarget = null;
		renderOverlay();
		if (notifyParent) {
			window.parent.postMessage({ type: '__preview-element-picker-cancelled' }, ideOrigin);
		}
	}

	function selectTarget(target) {
		if (!target) {
			return;
		}

		var reference = buildPreviewElementReference(target);
		pickerActive = false;
		pickerTarget = null;
		renderOverlay();
		window.parent.postMessage({ type: '__preview-element-picked', reference: reference }, ideOrigin);
	}

	function clearHighlightedTarget() {
		highlightedTarget = null;
		stickyHighlightActive = false;
		renderOverlay();
	}

	function setHighlightedTarget(reference, sticky) {
		highlightedTarget = findElementByReference(reference);
		stickyHighlightActive = !!sticky && !!highlightedTarget;
		renderOverlay();
		return !!highlightedTarget;
	}

	function isElementWithinViewport(element) {
		var rect = element.getBoundingClientRect();
		return rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth;
	}

	function revealHighlightedTarget(reference, options) {
		highlightedTarget = findElementByReference(reference);
		stickyHighlightActive = !!(options && options.sticky) && !!highlightedTarget;
		var shouldScroll =
			highlightedTarget &&
			((options && options.scroll === 'always') ||
				(options && options.scroll === 'if-needed' ? !isElementWithinViewport(highlightedTarget) : true));
		if (shouldScroll && typeof highlightedTarget.scrollIntoView === 'function') {
			highlightedTarget.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
		}
		renderOverlay();
		return !!highlightedTarget;
	}

	window.addEventListener(
		'pointermove',
		function (event) {
			if (!pickerActive) {
				return;
			}
			if (event.pointerType === 'touch') {
				event.preventDefault();
			}
			setPickerTargetFromPoint(event.clientX, event.clientY);
		},
		true,
	);

	window.addEventListener(
		'touchmove',
		function (event) {
			if (!pickerActive || !event.touches[0]) {
				return;
			}
			event.preventDefault();
			setPickerTargetFromPoint(event.touches[0].clientX, event.touches[0].clientY);
		},
		{ capture: true, passive: false },
	);

	window.addEventListener(
		'click',
		function (event) {
			if (!pickerActive) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			selectTarget(getElementFromPoint(event.clientX, event.clientY));
		},
		true,
	);

	window.addEventListener(
		'pointerdown',
		function (event) {
			if (!pickerActive && stickyHighlightActive) {
				clearHighlightedTarget();
			}

			if (!pickerActive) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			setPickerTargetFromPoint(event.clientX, event.clientY);
		},
		true,
	);

	window.addEventListener(
		'touchstart',
		function (event) {
			if (!pickerActive && stickyHighlightActive) {
				clearHighlightedTarget();
			}

			if (!pickerActive || !event.touches[0]) {
				return;
			}

			event.preventDefault();
			event.stopPropagation();
			setPickerTargetFromPoint(event.touches[0].clientX, event.touches[0].clientY);
		},
		{ capture: true, passive: false },
	);

	window.addEventListener(
		'touchend',
		function (event) {
			if (!pickerActive || !event.changedTouches[0]) {
				return;
			}

			event.preventDefault();
			event.stopPropagation();
			selectTarget(getElementFromPoint(event.changedTouches[0].clientX, event.changedTouches[0].clientY));
		},
		{ capture: true, passive: false },
	);

	window.addEventListener(
		'wheel',
		function () {
			if (!pickerActive && stickyHighlightActive) {
				clearHighlightedTarget();
			}
		},
		true,
	);

	window.addEventListener(
		'keydown',
		function (event) {
			if (!pickerActive && stickyHighlightActive) {
				clearHighlightedTarget();
			}

			if (!pickerActive) {
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				cancelPicker(true);
			}
		},
		true,
	);

	window.addEventListener(
		'scroll',
		function () {
			if (pickerActive || highlightedTarget) {
				renderOverlay();
			}
		},
		true,
	);

	window.addEventListener('resize', renderOverlay);

	window.addEventListener('message', function (event) {
		if (event.source !== window.parent || event.origin !== ideOrigin || !event.data || typeof event.data.type !== 'string') {
			return;
		}

		if (event.data.type === '__preview-element-picker-start') {
			pickerActive = true;
			pickerTarget = null;
			stickyHighlightActive = false;
			highlightedTarget = null;
			renderOverlay();
			return;
		}

		if (event.data.type === '__preview-element-picker-cancel') {
			cancelPicker(false);
			return;
		}

		if (event.data.type === '__preview-element-highlight' && event.data.reference && typeof event.data.reference === 'object') {
			setHighlightedTarget(event.data.reference, !!event.data.sticky);
			return;
		}

		if (event.data.type === '__preview-element-reveal' && event.data.reference && typeof event.data.reference === 'object') {
			revealHighlightedTarget(event.data.reference, { sticky: !!event.data.sticky, scroll: event.data.scroll });
			return;
		}

		if (
			event.data.type === '__preview-element-resolve' &&
			event.data.reference &&
			typeof event.data.reference === 'object' &&
			typeof event.data.requestId === 'string'
		) {
			window.parent.postMessage(
				{ type: '__preview-element-resolved', requestId: event.data.requestId, found: !!findElementByReference(event.data.reference) },
				ideOrigin,
			);
			return;
		}

		if (event.data.type === '__preview-element-highlight-clear') {
			clearHighlightedTarget();
		}
	});
})();
