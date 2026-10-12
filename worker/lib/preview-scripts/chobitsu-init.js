/**
 * Chobitsu CDP Init Script for Preview
 *
 * Initializes chobitsu (Chrome DevTools Protocol in JS) and sets up
 * the message relay between the preview iframe and the parent IDE frame.
 *
 * Runtime.enable is called immediately so that Runtime.consoleAPICalled
 * CDP events fire regardless of whether the DevTools panel is open.
 * The remaining CDP domains are enabled when the DevTools panel sends LOADED.
 *
 * Must be loaded after __chobitsu.js (which defines the global `chobitsu`).
 *
 * Reads config from window.__PREVIEW_CONFIG:
 *   { ideOrigin: string }
 */
(function () {
	if (typeof chobitsu === 'undefined') {
		console.error('[devtools] chobitsu not available after script load');
		return;
	}

	var ideOrigin = window.__PREVIEW_CONFIG && window.__PREVIEW_CONFIG.ideOrigin;
	if (typeof ideOrigin !== 'string' || ideOrigin === '*') return;
	var id = 0;

	var isEmbedded = window.parent !== window;

	function sendToDevtools(message) {
		if (isEmbedded) window.parent.postMessage(message, ideOrigin);
	}

	function sendToChobitsu(message) {
		message.id = 'tmp' + ++id;
		chobitsu.sendRawMessage(JSON.stringify(message));
	}

	function toOneBased(value) {
		return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.floor(value) + 1) : undefined;
	}

	function locationFromCallFrame(callFrame) {
		if (!callFrame || typeof callFrame.url !== 'string' || !callFrame.url) return null;
		return {
			file: callFrame.url,
			line: toOneBased(callFrame.lineNumber),
			column: toOneBased(callFrame.columnNumber),
		};
	}

	function firstStackLocation(stackTrace) {
		if (!stackTrace) return null;
		if (Array.isArray(stackTrace.callFrames)) {
			for (var i = 0; i < stackTrace.callFrames.length; i++) {
				var location = locationFromCallFrame(stackTrace.callFrames[i]);
				if (location) return location;
			}
		}
		return firstStackLocation(stackTrace.parent);
	}

	function locationFromExceptionDetails(detail) {
		if (!detail) return null;
		if (typeof detail.url === 'string' && detail.url) {
			return {
				file: detail.url,
				line: toOneBased(detail.lineNumber),
				column: toOneBased(detail.columnNumber),
			};
		}
		return firstStackLocation(detail.stackTrace);
	}

	function withLocation(payload, location) {
		if (location) payload.location = location;
		return payload;
	}

	// Enable Runtime and Log immediately so console logs and browser
	// issues are captured even when the DevTools panel is not open.
	sendToChobitsu({ method: 'Runtime.enable' });
	sendToChobitsu({ method: 'Log.enable' });

	function handleInit() {
		sendToDevtools(
			JSON.stringify({
				method: 'Page.frameNavigated',
				params: {
					frame: { id: '1', mimeType: 'text/html', securityOrigin: location.origin, url: location.href },
					type: 'Navigation',
				},
			}),
		);
		sendToChobitsu({ method: 'Network.enable' });
		sendToDevtools(JSON.stringify({ method: 'Runtime.executionContextsCleared' }));
		sendToChobitsu({ method: 'Runtime.enable' });
		sendToChobitsu({ method: 'Debugger.enable' });
		sendToChobitsu({ method: 'DOMStorage.enable' });
		sendToChobitsu({ method: 'DOM.enable' });
		sendToChobitsu({ method: 'CSS.enable' });
		sendToChobitsu({ method: 'Overlay.enable' });
		sendToDevtools(JSON.stringify({ method: 'DOM.documentUpdated' }));
	}

	chobitsu.setOnMessage(function (message) {
		if (message.includes('"id":"tmp')) return;
		try {
			if (message.includes('"Runtime.consoleAPICalled"')) {
				var parsed = JSON.parse(message);
				if (parsed.method === 'Runtime.consoleAPICalled' && parsed.params) {
					var args = parsed.params.args || [];
					var text = args
						.map(function (a) {
							if (a.type === 'string') return a.value;
							if (a.type === 'undefined') return 'undefined';
							if (a.value !== undefined) return String(a.value);
							if (a.description) return a.description;
							return a.type;
						})
						.join(' ');
					if (!text.startsWith('[hmr]') && isEmbedded) {
						var consoleType = parsed.params.type || 'log';
						var location =
							consoleType === 'error' || consoleType === 'warning' || consoleType === 'assert'
								? firstStackLocation(parsed.params.stackTrace)
								: null;
						window.parent.postMessage(
							withLocation(
								{
									type: '__console-log',
									level: consoleType,
									message: text,
									timestamp: parsed.params.timestamp ? Math.floor(parsed.params.timestamp) : Date.now(),
								},
								location,
							),
							ideOrigin,
						);
					}
				}
			}
			if (message.includes('"Log.entryAdded"')) {
				var parsedLog = JSON.parse(message);
				if (parsedLog.method === 'Log.entryAdded' && parsedLog.params && parsedLog.params.entry) {
					var entry = parsedLog.params.entry;
					var logLevel = entry.level === 'error' ? 'error' : entry.level === 'warning' ? 'warning' : 'info';
					var logText = entry.text || '';
					var logLocation =
						typeof entry.url === 'string' && entry.url
							? { file: entry.url, line: toOneBased(entry.lineNumber), column: toOneBased(entry.columnNumber) }
							: null;
					if (logText && isEmbedded) {
						window.parent.postMessage(
							withLocation(
								{
									type: '__console-log',
									level: logLevel,
									message: logText,
									timestamp: entry.timestamp ? Math.floor(entry.timestamp) : Date.now(),
								},
								logLocation,
							),
							ideOrigin,
						);
					}
				}
			}
			if (message.includes('"Runtime.exceptionThrown"')) {
				var parsedException = JSON.parse(message);
				if (parsedException.method === 'Runtime.exceptionThrown' && parsedException.params) {
					var detail = parsedException.params.exceptionDetails;
					if (detail) {
						var errorText = '';
						if (detail.exception && detail.exception.description) {
							errorText = detail.exception.description;
						} else if (detail.text) {
							errorText = detail.text;
						}
						if (errorText && isEmbedded) {
							var errorLocation = locationFromExceptionDetails(detail);
							window.parent.postMessage(
								withLocation(
									{
										type: '__console-log',
										level: 'error',
										message: errorText,
										timestamp: parsedException.params.timestamp ? Math.floor(parsedException.params.timestamp) : Date.now(),
									},
									errorLocation,
								),
								ideOrigin,
							);
						}
					}
				}
			}
		} catch (e) {
			/* ignore parse errors */
		}
		sendToDevtools(message);
	});

	window.addEventListener('message', function (event) {
		if (event.source !== window.parent || event.origin !== ideOrigin) return;
		try {
			var data = event.data;
			if (!data || !data.event) return;
			if (data.event === 'DEV' && typeof data.data === 'string') {
				chobitsu.sendRawMessage(data.data);
			} else if (data.event === 'LOADED') {
				handleInit();
			}
		} catch (e) {
			console.error('[devtools]', e);
		}
	});

	// Notify parent that chobitsu is ready
	if (isEmbedded) window.parent.postMessage({ type: '__chobitsu-ready' }, ideOrigin);
})();
