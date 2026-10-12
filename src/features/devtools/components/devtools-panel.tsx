import { useEffect, useMemo, useRef } from 'react';

import { useResolvedTheme } from '@/hooks/use-theme';
import { cn } from '@/lib/utils';

export interface DevelopmentToolsPanelProperties {
	previewIframeReference: React.RefObject<HTMLIFrameElement | null>;
	previewOrigin: string | undefined;
	className?: string;
}

/**
 * Send navigation reset CDP events to the DevTools frontend so it
 * refreshes Elements/Console/Network after a preview reload.
 */
function notifyDevtoolsOfNavigation(devtoolsWindow: Window, previewWindow: Window | undefined | null, previewOrigin: string): void {
	let url: string;
	try {
		// Cross-origin iframes block access to location.href — fall back to the preview origin.
		url = previewWindow ? String(previewWindow.location.href) : previewOrigin;
	} catch {
		url = previewOrigin;
	}
	devtoolsWindow.postMessage(
		JSON.stringify({
			method: 'Page.frameNavigated',
			params: {
				frame: { id: '1', mimeType: 'text/html', securityOrigin: previewOrigin, url },
				type: 'Navigation',
			},
		}),
		'*',
	);
	devtoolsWindow.postMessage(JSON.stringify({ method: 'Runtime.executionContextsCleared' }), '*');
	devtoolsWindow.postMessage(JSON.stringify({ method: 'DOM.documentUpdated' }), '*');
}

/**
 * Apply the resolved editor theme to the sandboxed DevTools iframe.
 *
 * The iframe is intentionally sandboxed without `allow-same-origin`, so theme
 * updates are forwarded via `postMessage` instead of direct DOM access.
 */
function postThemeToDevtools(devtoolsWindow: Window | null | undefined, theme: 'light' | 'dark'): void {
	devtoolsWindow?.postMessage({ type: '__worker-ide-theme', theme }, '*');
}

function isProtocolMessage(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	try {
		const message: unknown = JSON.parse(value);
		return (
			!!message &&
			typeof message === 'object' &&
			(('method' in message && typeof message.method === 'string') || ('id' in message && typeof message.id === 'number'))
		);
	} catch {
		return false;
	}
}

export function DevelopmentToolsPanel({ previewIframeReference, previewOrigin, className }: DevelopmentToolsPanelProperties) {
	const devtoolsIframeReference = useRef<HTMLIFrameElement>(null);
	const devtoolsReadyReference = useRef(false);
	const resolvedTheme = useResolvedTheme();

	// Generate the DevTools frontend URL using chii's hosted build
	const devtoolsSource = useMemo(() => {
		const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>DevTools</title>
<style>
@media (prefers-color-scheme: dark) {
  body { background-color: rgb(41 42 45); }
}
</style>
<meta name="referrer" content="no-referrer">
<script>
// Chii expects Web Storage. Sandboxed documents without allow-same-origin throw
// when localStorage/sessionStorage are read, so provide ephemeral storage.
(function () {
  function createStorage() {
    var values = Object.create(null);
    return {
      get length() {
        return Object.keys(values).length;
      },
      key: function (index) {
        return Object.keys(values)[index] || null;
      },
      getItem: function (key) {
        key = String(key);
        return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
      },
      setItem: function (key, value) {
        values[String(key)] = String(value);
      },
      removeItem: function (key) {
        delete values[String(key)];
      },
      clear: function () {
        values = Object.create(null);
      }
    };
  }

  try {
    Object.defineProperty(window, 'localStorage', { value: createStorage(), configurable: true });
    Object.defineProperty(window, 'sessionStorage', { value: createStorage(), configurable: true });
  } catch (error) {
    console.warn('[devtools] failed to install storage shim', error);
  }
})();

window.addEventListener('message', function (event) {
  if (event.source !== window.parent || event.origin !== ${JSON.stringify(globalThis.location.origin)}) return;
  if (!event.data || event.data.type !== '__worker-ide-theme' || !['light', 'dark'].includes(event.data.theme)) return;
  var theme = event.data.theme === 'dark' ? 'dark' : 'light';
  var meta = document.head.querySelector('meta[name="color-scheme"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'color-scheme';
    document.head.appendChild(meta);
  }
  meta.content = theme;
  document.documentElement.classList.toggle('-theme-with-dark-background', theme === 'dark');
});
</script>
<script src="https://unpkg.com/@ungap/custom-elements/es.js"></script>
<script type="module" src="https://cdn.jsdelivr.net/npm/chii@1/public/front_end/entrypoints/chii_app/chii_app.js"></script>
</head>
<body class="undocked" id="-blink-dev-tools">
</body>
</html>`;
		const blobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
		const origin = encodeURIComponent(globalThis.location.origin);
		return `${blobUrl}#?embedded=${origin}`;
	}, []);

	// Clean up blob URL on unmount
	useEffect(() => {
		const blobUrl = devtoolsSource.split('#')[0];
		return () => URL.revokeObjectURL(blobUrl);
	}, [devtoolsSource]);

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const previewWindow = previewIframeReference.current?.contentWindow;
			const devtoolsWindow = devtoolsIframeReference.current?.contentWindow;
			const isFromPreview = !!previewWindow && !!previewOrigin && event.source === previewWindow && event.origin === previewOrigin;
			const isFromDevtools = !!devtoolsWindow && event.source === devtoolsWindow && event.origin === 'null';

			// Chobitsu ready — preview (re)loaded and chobitsu initialized.
			// Send LOADED to trigger the CDP init sequence, and notify the
			// DevTools frontend that the page has navigated so it refreshes.
			if (isFromPreview && typeof event.data === 'object' && event.data?.type === '__chobitsu-ready') {
				if (devtoolsReadyReference.current && devtoolsWindow && previewOrigin) {
					previewWindow?.postMessage({ event: 'LOADED' }, previewOrigin);
					notifyDevtoolsOfNavigation(devtoolsWindow, previewWindow, previewOrigin);
				}
				return;
			}

			// From preview → devtools: only forward raw CDP strings (not object messages)
			if (isFromPreview && isProtocolMessage(event.data)) {
				devtoolsWindow?.postMessage(event.data, '*');
				return;
			}

			// From devtools → preview: wrap as { event: 'DEV', data }
			if (isFromDevtools && previewOrigin && isProtocolMessage(event.data)) {
				previewWindow?.postMessage({ event: 'DEV', data: event.data }, previewOrigin);
				return;
			}
		};

		globalThis.addEventListener('message', handleMessage);
		return () => globalThis.removeEventListener('message', handleMessage);
	}, [previewIframeReference, previewOrigin]);

	// Mark DevTools frontend as ready once its iframe loads.
	// Also send LOADED in case the preview's __chobitsu-ready arrived first.
	const handleDevtoolsLoad = () => {
		devtoolsReadyReference.current = true;
		postThemeToDevtools(devtoolsIframeReference.current?.contentWindow, resolvedTheme);
		if (previewOrigin) {
			previewIframeReference.current?.contentWindow?.postMessage({ event: 'LOADED' }, previewOrigin);
		}
	};

	// Re-apply theme whenever the editor theme changes after initial load.
	useEffect(() => {
		if (devtoolsReadyReference.current) {
			postThemeToDevtools(devtoolsIframeReference.current?.contentWindow, resolvedTheme);
		}
	}, [resolvedTheme]);

	return (
		<div className={cn('flex h-full flex-col overflow-hidden', className)}>
			<iframe
				ref={devtoolsIframeReference}
				src={devtoolsSource}
				onLoad={handleDevtoolsLoad}
				className="size-full border-0"
				sandbox="allow-scripts"
				referrerPolicy="no-referrer"
				title="DevTools"
			/>
		</div>
	);
}
