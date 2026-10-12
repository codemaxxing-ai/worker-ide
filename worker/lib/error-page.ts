interface ErrorPageOptions {
	title?: string;
	heading: string;
	message: string;
	homeUrl?: string;
	status: number;
}
function escapeHtml(unsafe: string): string {
	return unsafe
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#039;');
}

export function errorPage({ title, heading, message, homeUrl, status }: ErrorPageOptions): Response {
	const pageTitle = escapeHtml(title ?? 'Worker IDE');

	// SVG hexagon icon matching the app branding (Lucide Hexagon)
	const hexagonSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>`;

	const homeButton = homeUrl
		? `<a href="${escapeHtml(homeUrl)}" style="
				display:inline-flex;align-items:center;gap:8px;
				padding:10px 20px;border-radius:6px;
				background:#f14602;color:#fff;
				font-size:14px;font-weight:500;
				text-decoration:none;transition:background 0.15s;
			" onmouseover="this.style.background='#ff6d33'" onmouseout="this.style.background='#f14602'">
				<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
				Back to Home
			</a>`
		: '';

	const html = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>${pageTitle}</title>
	<link rel="icon" type="image/svg+xml" href="/favicon.svg">
	<style>
		*{margin:0;padding:0;box-sizing:border-box}
		body{
			font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
			background:#121212;color:#f0e3de;
			display:flex;align-items:center;justify-content:center;
			min-height:100vh;padding:16px;
		}
		.card{
			max-width:480px;width:100%;
			border:1px solid rgba(240,227,222,0.125);
			background:#191817;border-radius:12px;
			padding:40px;box-shadow:0 4px 24px rgba(0,0,0,0.3);
		}
		.icon{color:#f14602;margin-bottom:16px}
		h1{font-size:20px;font-weight:600;margin-bottom:8px;color:#f0e3de}
		p{font-size:14px;color:rgba(255,253,251,0.56);line-height:1.6;margin-bottom:32px}
	</style>
</head>
<body>
	<div class="card">
		<div class="icon">${hexagonSvg}</div>
		<h1>${escapeHtml(heading)}</h1>
		<p>${escapeHtml(message)}</p>
		${homeButton}
	</div>
</body>
</html>`;

	return new Response(html, {
		status,
		headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Referrer-Policy': 'no-referrer' },
	});
}

/**
 * Build a Response for an expired HMAC preview token.
 *
 * The page behaves differently depending on context:
 *
 * **Embedded in the IDE iframe** (`window.self !== window.top`):
 *   Shows a minimal "Refreshing preview…" spinner and immediately posts
 *   `{ type: '__preview-expired' }` to `window.parent`. The IDE preview
 *   panel listens for this message and silently fetches a fresh signed URL,
 *   then reloads the iframe. The user barely sees this page.
 *
 * **Opened directly in a browser tab**:
 *   Shows a full styled card matching the app's error page pattern
 *   (`NotFoundPage` / `ProjectNotFound`) with a "Back to Home" button.
 */
export function previewExpiredPage(appOrigin: string): Response {
	const homeUrl = escapeHtml(`${appOrigin}/`);

	// Lucide TimerOff icon
	const timerOffSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6v6l4 2"/><path d="M22 13a10 10 0 1 1-5.16-8.75"/><path d="m2 2 20 20"/></svg>`;

	const html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Preview link expired</title>
	<style>
		*{margin:0;padding:0;box-sizing:border-box}
		body{
			font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
			background:#121212;color:#f0e3de;
			display:flex;align-items:center;justify-content:center;
			min-height:100vh;padding:16px;
		}

		/* ---- Iframe view: minimal refreshing state ---- */
		.refreshing{
			display:flex;flex-direction:column;align-items:center;gap:12px;
			color:rgba(255,253,251,0.56);font-size:14px;
		}
		.spinner{
			width:24px;height:24px;border-radius:50%;
			border:2px solid rgba(255,253,251,0.2);
			border-top-color:#f14602;
			animation:spin 0.7s linear infinite;
		}
		@keyframes spin{to{transform:rotate(360deg)}}

		/* ---- Direct view: full card ---- */
		.card{
			display:none;
			max-width:480px;width:100%;
			border:1px solid rgba(240,227,222,0.125);
			background:#191817;border-radius:12px;
			padding:40px;box-shadow:0 4px 24px rgba(0,0,0,0.3);
		}
		.icon{color:#f14602;margin-bottom:16px}
		h1{font-size:20px;font-weight:600;margin-bottom:8px;color:#f0e3de}
		p{font-size:14px;color:rgba(255,253,251,0.56);line-height:1.6;margin-bottom:32px}
		.btn{
			display:inline-flex;align-items:center;gap:8px;
			padding:10px 20px;border-radius:6px;
			background:#f14602;color:#fff;
			font-size:14px;font-weight:500;font-family:inherit;
			text-decoration:none;border:none;cursor:pointer;
			transition:background 0.15s;
		}
		.btn:hover{background:#ff6d33}
	</style>
</head>
<body>
	<!-- Shown when embedded in iframe (token expired, auto-refresh in progress) -->
	<div class="refreshing" id="iframe-view">
		<div class="spinner"></div>
		<span>Refreshing preview&hellip;</span>
	</div>

	<!-- Shown when visited directly in a browser tab -->
	<div class="card" id="direct-view">
		<div class="icon">${timerOffSvg}</div>
		<h1>Preview link expired</h1>
		<p>
			This preview link is no longer valid. Preview links expire after a short time
			to keep your project secure. Open the editor to get a fresh preview link.
		</p>
		<a href="${homeUrl}" class="btn">
			<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
			Back to Home
		</a>
	</div>

	<script>
		if (window.self !== window.top) {
			// Embedded in iframe: notify the IDE and show spinner
			window.parent.postMessage({ type: '__preview-expired' }, ${JSON.stringify(appOrigin)});
		} else {
			// Direct visit: hide spinner, show full card
			document.getElementById('iframe-view').style.display = 'none';
			document.getElementById('direct-view').style.display = 'block';
		}
	</script>
</body>
</html>`;

	return new Response(html, {
		status: 403,
		headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Referrer-Policy': 'no-referrer' },
	});
}

/** Platform-owned page: never render the editor login inside an untrusted frame. */
export function previewAccessPage(appOrigin: string, reason: 'required' | 'blocked'): Response {
	const type = reason === 'blocked' ? '__preview-access-blocked' : '__preview-access-required';
	const targetOrigin = JSON.stringify(appOrigin).replaceAll('<', String.raw`\u003c`);
	return new Response(
		`<!doctype html><html><head><meta charset="utf-8"><title>Preview access</title></head><body><p>${reason === 'blocked' ? 'Preview cookies are blocked.' : 'Preview access expired.'}</p><script>if(window.parent!==window)window.parent.postMessage({type:${JSON.stringify(type)}},${targetOrigin});</script></body></html>`,
		{
			status: 403,
			headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store' },
		},
	);
}
