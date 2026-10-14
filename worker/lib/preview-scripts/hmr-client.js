/**
 * HMR transport client for preview.
 *
 * Owns only connection lifecycle and version tracking. All update behavior
 * lives in `window.__PREVIEW_RUNTIME__`.
 */
(function () {
	var config = window.__PREVIEW_CONFIG;
	if (!config || !config.wsUrl) return;

	var socket = new WebSocket(config.wsUrl);
	var ideOrigin = config.ideOrigin;
	if (typeof ideOrigin !== 'string' || ideOrigin === '*') return;
	var version = Number.isFinite(config.bootVersion) ? config.bootVersion : 0;

	var reloadTimer = null;
	var RELOAD_DEBOUNCE_MS = 200;

	function emitRuntimeEvent(event, payload) {
		var runtime = window.__PREVIEW_RUNTIME__;
		if (runtime && typeof runtime.emitEvent === 'function') {
			runtime.emitEvent(event, payload);
		}
	}

	// Report HMR lifecycle status to the parent IDE so it can surface a live
	// indicator (connected / updating / updated / reloading / error).
	function postStatus(status) {
		if (window.parent !== window) {
			window.parent.postMessage({ type: '__hmr-status', status: status }, ideOrigin);
		}
	}

	// Allow modules using import.meta.hot.send(event, data) to deliver custom
	// messages back over the websocket. The coordinator ignores unknown
	// message types, so this is safe even without a server-side consumer.
	window.__PREVIEW_RUNTIME_SEND__ = function (event, data) {
		if (socket.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify({ type: 'custom', event: event, data: data }));
		}
	};

	function debouncedReload() {
		if (reloadTimer) clearTimeout(reloadTimer);
		reloadTimer = setTimeout(function () {
			reloadTimer = null;
			var runtimeReload = window.__PREVIEW_RUNTIME_RELOAD__;
			if (typeof runtimeReload === 'function') {
				runtimeReload();
				return;
			}
			location.reload();
		}, RELOAD_DEBOUNCE_MS);
	}

	async function applyUpdates(updates) {
		var runtime = window.__PREVIEW_RUNTIME__;
		if (!runtime || typeof runtime.applyUpdate !== 'function') {
			debouncedReload();
			return;
		}

		for (var index = 0; index < updates.length; index++) {
			await runtime.applyUpdate(updates[index]);
		}
	}

	socket.addEventListener('message', function (event) {
		var data = JSON.parse(event.data);

		if (typeof data.version === 'number' && data.version > version) {
			version = data.version;
		}

		if (data.type === 'full-reload') {
			postStatus('reloading');
			debouncedReload();
			return;
		}

		// Server-driven rebuild lifecycle for warm-build adapters whose (slow) build
		// happens out-of-band from the client Fast Refresh path. Surface it in the
		// IDE header via the shared HMR status indicator.
		if (data.type === 'runtime-status' && data.status) {
			window.dispatchEvent(new CustomEvent('__preview-runtime-status', { detail: data.status }));
			return;
		}
		if (data.type === 'custom' && data.event === 'preview:rebuild') {
			postStatus(data.data && data.data.status === 'start' ? 'building' : 'updated');
			return;
		}

		// Custom events pushed from the server (Vite's import.meta.hot.on).
		if (data.type === 'custom' && typeof data.event === 'string') {
			emitRuntimeEvent(data.event, data.data);
			return;
		}

		if (data.type === 'server-error' && data.error) {
			postStatus('error');
			emitRuntimeEvent('vite:error', { err: data.error });
			if (typeof window.showErrorOverlay === 'function' && data.error.type === 'bundle') {
				window.showErrorOverlay(data.error);
			}
			if (window.parent !== window) {
				window.parent.postMessage(
					{
						type: '__server-error',
						error: data.error,
					},
					ideOrigin,
				);
			}
			return;
		}

		if (data.type === 'update') {
			if (typeof window.hideErrorOverlay === 'function') {
				window.hideErrorOverlay();
			}
			// Re-fetching a changed module triggers its server-side rebuild (transform
			// or bundle), so surface the same rebuilding indicator as warm-build adapters.
			postStatus('building');
			applyUpdates(data.updates)
				.then(function () {
					postStatus('updated');
				})
				.catch(function (error) {
					console.error('[hmr] update failed', error);
					debouncedReload();
				});
		}
	});

	socket.addEventListener('open', function () {
		console.log('[hmr] connected.');
		socket.send(JSON.stringify({ type: 'hmr-connect', version: version }));
		emitRuntimeEvent('vite:ws:connect', {});
		postStatus('connected');
	});

	socket.addEventListener('close', function () {
		console.log('[hmr] server connection lost. polling for restart...');
		emitRuntimeEvent('vite:ws:disconnect', {});
		postStatus('disconnected');
		function poll() {
			fetch(location.href, { method: 'HEAD' })
				.then(function () {
					location.reload();
				})
				.catch(function () {
					setTimeout(poll, 1000);
				});
		}
		setTimeout(poll, 1000);
	});

	setInterval(function () {
		if (socket.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify({ type: 'ping' }));
		}
	}, 30000);
})();
