/** Browser requests may not borrow a sibling project's credentials, even before PSL adoption. */
export function isForbiddenPreviewRequest(request: Request, appOrigin: string): boolean {
	if (request.headers.get('Service-Worker') === 'script' || request.headers.get('Sec-Fetch-Dest') === 'serviceworker') return true;
	const origin = request.headers.get('Origin');
	const destination = request.headers.get('Sec-Fetch-Dest');
	const navigation = request.method === 'GET' || request.method === 'HEAD';
	const editorNavigation = navigation && destination === 'iframe' && origin === appOrigin;
	if (origin && origin !== new URL(request.url).origin && !editorNavigation) return true;
	const site = request.headers.get('Sec-Fetch-Site');
	if (!site || site === 'same-origin' || site === 'none') return false;
	return !navigation || (destination !== 'document' && destination !== 'iframe');
}
