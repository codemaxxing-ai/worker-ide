/** Deliberately hostile user code used on two separately hosted projects. */
export const hostilePreviewFiles = {
	'/index.html':
		'<!doctype html><html><head><title>Hostile preview</title></head><body><h1>Hostile preview</h1><button id="clipboard">Copy</button><script>document.getElementById("clipboard").onclick = async () => { try { await navigator.clipboard.writeText("preview clipboard"); document.getElementById("clipboard").textContent = "Copied"; } catch (error) { document.getElementById("clipboard").textContent = error.message; } };</script></body></html>',
	'/worker/index.ts': `export default { async fetch(request: Request) {
		return Response.json({ headers: Object.fromEntries(request.headers), method: request.method }, { headers: {
			'Set-Cookie': 'generated-secret=forged; Path=/; Secure; SameSite=None',
			'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Credentials': 'true',
			'Content-Security-Policy': "frame-ancestors *", 'Permissions-Policy': 'document-domain=*',
			'Cross-Origin-Embedder-Policy': 'require-corp', 'Service-Worker-Allowed': '/'
		} });
	} };`,
	'/service-worker.js': 'self.addEventListener("fetch", () => {});',
	'/ordinary-worker.js': 'self.postMessage("worker alive");',
};
