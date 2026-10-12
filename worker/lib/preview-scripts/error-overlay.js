/**
 * Error Overlay for Preview
 *
 * Renders a styled error overlay inside the preview iframe when a
 * build or runtime error occurs. Exposes window.showErrorOverlay()
 * and window.hideErrorOverlay() for the HMR client to call.
 *
 * Clicking the file location sends a canonical project deep-link target
 * to the IDE. When opened full-screen, it opens the IDE
 * using the same canonical deep-link query format.
 *
 * Reads config from window.__PREVIEW_CONFIG:
 *   { ideOrigin: string, projectId: string }
 */
(function () {
	var config = window.__PREVIEW_CONFIG || {};
	var ideOrigin = config.ideOrigin;
	if (typeof ideOrigin !== 'string' || ideOrigin === '*') return;
	var projectId = config.projectId || null;
	var lastError = null;

	function esc(s) {
		return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	function normalizeDeepLinkFilePath(path) {
		var trimmedPath = (path || '').trim();
		if (!trimmedPath) return '/';
		var withoutCurrentDirectoryPrefix = trimmedPath.replace(/^(?:\.\/)+/, '');
		var withSingleLeadingSlash =
			withoutCurrentDirectoryPrefix.charAt(0) === '/'
				? '/' + withoutCurrentDirectoryPrefix.replace(/^\/+/, '')
				: '/' + withoutCurrentDirectoryPrefix;
		return withSingleLeadingSlash.replace(/\/{2,}/g, '/');
	}

	function linkifyFiles(escaped) {
		return escaped.replace(
			/(?:^|\s)((?:[\w.@\-]+\/)*[\w.\-]+\.(?:ts|tsx|js|jsx|css|html|json|mjs|cjs|vue|svelte)):(\d+):(\d+)/gm,
			function (match, file, line, col) {
				var normalizedFile = normalizeDeepLinkFilePath(file);
				var leading = match.charAt(0) !== file.charAt(0) ? match.charAt(0) : '';
				return (
					leading +
					'<span class="__eo-file-link" data-file="' +
					normalizedFile +
					'" data-line="' +
					line +
					'" data-column="' +
					col +
					'">' +
					file +
					':' +
					line +
					':' +
					col +
					'</span>'
				);
			},
		);
	}

	function showErrorPill() {
		hideErrorPill();
		if (!lastError) return;
		var pill = document.createElement('div');
		pill.id = '__error-pill';
		pill.innerHTML =
			'<style>' +
			'#__error-pill{position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:99998;cursor:pointer;' +
			'background:rgba(248,81,73,0.15);border:1px solid rgba(248,81,73,0.5);border-radius:20px;padding:6px 14px;' +
			'display:flex;align-items:center;gap:6px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,monospace;' +
			'backdrop-filter:blur(8px);transition:background 0.15s}' +
			'#__error-pill:hover{background:rgba(248,81,73,0.25)}' +
			'#__error-pill .__ep-dot{width:8px;height:8px;border-radius:50%;background:#f85149;flex-shrink:0}' +
			'#__error-pill .__ep-label{color:#f85149;font-size:12px;font-weight:600;white-space:nowrap}' +
			'</style>' +
			'<span class="__ep-dot"></span>' +
			'<span class="__ep-label">Build Error</span>';
		document.body.appendChild(pill);
		pill.addEventListener('click', function () {
			if (lastError) showErrorOverlay(lastError);
		});
	}

	function hideErrorPill() {
		var el = document.getElementById('__error-pill');
		if (el) el.remove();
	}

	function dismissOverlay() {
		var el = document.getElementById('__error-overlay');
		if (el) el.remove();
		showErrorPill();
	}

	function buildIdeDeepLinkUrl(target) {
		if (!projectId) return undefined;

		var url = new URL('/p/' + projectId, ideOrigin);
		if (target.kind === 'agent-session') {
			url.searchParams.set('session', target.sessionId);
			return url.toString();
		}

		if (target.kind === 'panel') {
			url.searchParams.set('panel', target.panel);
			return url.toString();
		}

		url.searchParams.set('file', target.file.path);
		if (target.file.line !== undefined) {
			url.searchParams.set('line', String(target.file.line));
			if (target.file.column !== undefined) {
				url.searchParams.set('column', String(target.file.column));
			}
		}
		return url.toString();
	}

	function openProjectDeepLink(target) {
		if (window.parent !== window) {
			window.parent.postMessage({ type: '__deep-link', target: target }, ideOrigin);
			return;
		}
		var deepLinkUrl = buildIdeDeepLinkUrl(target);
		if (deepLinkUrl) window.open(deepLinkUrl, '_blank', 'noopener,noreferrer');
	}

	function getErrorLocation(err) {
		if (!err || !err.location || !err.location.file) return null;
		return err.location;
	}

	function showErrorOverlay(err) {
		hideErrorOverlay();
		lastError = err;
		// Notify the parent IDE frame so panels (e.g. dependency panel) can react
		if (window.parent !== window) {
			window.parent.postMessage({ type: '__server-error', error: err }, ideOrigin);
		}
		var overlay = document.createElement('div');
		overlay.id = '__error-overlay';
		var location = getErrorLocation(err);
		var loc = location
			? esc(location.file + (location.line ? ':' + location.line : '') + (location.column ? ':' + location.column : ''))
			: '';
		var hasDependencyErrors = Array.isArray(err.dependencyErrors) && err.dependencyErrors.length > 0;
		overlay.innerHTML =
			'<style>' +
			'#__error-overlay{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,monospace}' +
			'.__eo-card{background:#1a1a2e;color:#e0e0e0;border-radius:12px;max-width:640px;width:90%;max-height:80vh;overflow:auto;box-shadow:0 8px 32px rgba(0,0,0,0.5);border:1px solid rgba(248,81,73,0.4)}' +
			'.__eo-header{padding:16px 20px;border-bottom:1px solid rgba(248,81,73,0.3);display:flex;align-items:center;gap:10px}' +
			'.__eo-badge{background:rgba(248,81,73,0.2);color:#f85149;font-size:11px;font-weight:700;text-transform:uppercase;padding:2px 8px;border-radius:4px}' +
			'.__eo-title{color:#f85149;font-size:14px;font-weight:600;flex:1}' +
			'.__eo-close{background:none;border:none;color:#8b949e;cursor:pointer;font-size:18px;padding:4px 8px;border-radius:4px}' +
			'.__eo-close:hover{background:rgba(255,255,255,0.1);color:#e0e0e0}' +
			'.__eo-copy{background:none;border:none;color:#8b949e;cursor:pointer;padding:4px 8px;border-radius:4px;display:flex;align-items:center}' +
			'.__eo-copy:hover{background:rgba(255,255,255,0.1);color:#e0e0e0}' +
			'.__eo-copy svg{width:16px;height:16px}' +
			'.__eo-body{padding:16px 20px}' +
			'.__eo-file{color:#58a6ff;font-size:13px;margin-bottom:12px;cursor:pointer;text-decoration:underline}' +
			'.__eo-file:hover{color:#79b8ff}' +
			'.__eo-actions{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}' +
			'.__eo-action{background:none;border:1px solid rgba(88,166,255,0.45);color:#58a6ff;cursor:pointer;border-radius:6px;padding:6px 10px;font-size:12px}' +
			'.__eo-action:hover{background:rgba(88,166,255,0.12);color:#79b8ff}' +
			'.__eo-msg{background:#0d1117;border-radius:8px;padding:14px 16px;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-all;color:#f0f0f0;border:1px solid rgba(48,54,61,0.8)}' +
			'.__eo-file-link{color:#58a6ff;cursor:pointer;text-decoration:underline}' +
			'.__eo-file-link:hover{color:#79b8ff}' +
			'</style>' +
			'<div class="__eo-card">' +
			'<div class="__eo-header">' +
			'<span class="__eo-badge">' +
			esc(err.type || 'error') +
			'</span>' +
			'<span class="__eo-title">Build Error</span>' +
			'<button class="__eo-copy" id="__eo-copy-btn" title="Copy error to clipboard">' +
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
			'</button>' +
			'<button class="__eo-close" id="__eo-close-btn">&times;</button>' +
			'</div>' +
			'<div class="__eo-body">' +
			(loc
				? '<div class="__eo-file" data-file="' +
					esc(normalizeDeepLinkFilePath(location.file || '')) +
					'" data-line="' +
					(location.line || 1) +
					'" data-column="' +
					(location.column || 1) +
					'">' +
					loc +
					'</div>'
				: '') +
			(hasDependencyErrors
				? '<div class="__eo-actions"><button class="__eo-action" id="__eo-dependencies-btn">Open Dependencies panel</button></div>'
				: '') +
			'<div class="__eo-msg">' +
			linkifyFiles(esc(err.message || 'Unknown error')) +
			'</div>' +
			'</div>' +
			'</div>';
		document.body.appendChild(overlay);
		hideErrorPill();
		overlay.querySelector('#__eo-close-btn').addEventListener('click', function () {
			dismissOverlay();
		});
		var copyBtn = overlay.querySelector('#__eo-copy-btn');
		copyBtn.addEventListener('click', function () {
			var text =
				(location
					? location.file + (location.line ? ':' + location.line : '') + (location.column ? ':' + location.column : '') + '\n'
					: '') + (err.message || 'Unknown error');
			navigator.clipboard.writeText(text).then(function () {
				copyBtn.innerHTML =
					'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
				setTimeout(function () {
					copyBtn.innerHTML =
						'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
				}, 2000);
			});
		});
		overlay.addEventListener('click', function (e) {
			if (e.target === overlay) dismissOverlay();
		});
		function handleFileClick(el) {
			var file = normalizeDeepLinkFilePath(el.dataset.file || '');
			var line = parseInt(el.dataset.line, 10) || 1;
			var column = parseInt(el.dataset.column, 10) || 1;
			openProjectDeepLink({
				kind: 'file',
				file: {
					path: file,
					line: line,
					column: column,
				},
			});
		}

		var fileEl = overlay.querySelector('.__eo-file');
		if (fileEl) {
			fileEl.addEventListener('click', function () {
				handleFileClick(fileEl);
			});
		}
		var dependenciesButton = overlay.querySelector('#__eo-dependencies-btn');
		if (dependenciesButton) {
			dependenciesButton.addEventListener('click', function () {
				openProjectDeepLink({ kind: 'panel', panel: 'dependencies' });
			});
		}
		overlay.querySelectorAll('.__eo-file-link').forEach(function (link) {
			link.addEventListener('click', function () {
				handleFileClick(link);
			});
		});
	}

	function hideErrorOverlay() {
		lastError = null;
		var el = document.getElementById('__error-overlay');
		if (el) el.remove();
		hideErrorPill();
	}

	window.showErrorOverlay = showErrorOverlay;
	window.hideErrorOverlay = hideErrorOverlay;
})();
