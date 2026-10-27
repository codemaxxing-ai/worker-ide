import { repoNameForProject } from './artifacts-repo';
import { verifyGitToken } from '../lib/git-token';

/**
 * Proxy Git Smart HTTP requests from the `git.<domain>` host to the project's
 * Cloudflare Artifacts remote.
 *
 * We keep this proxy (rather than handing the Artifacts remote to clients
 * directly) so that every git request is authorized with our own short-lived,
 * HMAC-signed token before we mint a real Artifacts token and forward. The
 * Artifacts token never reaches the client.
 *
 * Expected client URL: `https://git.<domain>/ide/<projectId>[.git]/<gitPath>`
 * where `<gitPath>` is `info/refs`, `git-upload-pack`, or `git-receive-pack`.
 */

const ARTIFACTS_NAMESPACE = 'ide';
const GIT_PATH_PATTERN = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

function unauthorized(): Response {
	return new Response('Unauthorized', {
		status: 401,
		headers: { 'WWW-Authenticate': 'Basic realm="git"' },
	});
}

function extractToken(request: Request): string | undefined {
	const header = request.headers.get('Authorization');
	if (!header) return undefined;

	if (header.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();

	if (header.startsWith('Basic ')) {
		try {
			const decoded = atob(header.slice('Basic '.length).trim());
			const separator = decoded.indexOf(':');
			return separator === -1 ? decoded : decoded.slice(separator + 1);
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function requiredScope(url: URL, gitPath: string): 'read' | 'write' {
	if (gitPath === 'git-receive-pack') return 'write';
	if (gitPath === 'info/refs' && url.searchParams.get('service') === 'git-receive-pack') return 'write';
	return 'read';
}

export async function handleGitProxy(request: Request, environment: Env): Promise<Response> {
	const url = new URL(request.url);
	const match = url.pathname.match(GIT_PATH_PATTERN);
	if (!match) return new Response('Not found', { status: 404 });

	const [, namespace, projectId, gitPath] = match;
	if (namespace !== ARTIFACTS_NAMESPACE) return new Response('Not found', { status: 404 });

	const token = extractToken(request);
	if (!token) return unauthorized();

	const claims = await verifyGitToken(environment.BETTER_AUTH_SECRET, token);
	if (!claims || claims.projectId !== projectId) return unauthorized();

	const scope = requiredScope(url, gitPath);
	if (scope === 'write' && claims.scope !== 'write') return unauthorized();

	// Authorized: mint a real Artifacts token and forward to the remote.
	let remote: string;
	let artifactsToken: string;
	try {
		using repo = await environment.ARTIFACTS.get(repoNameForProject(projectId));
		const metadata = await repo.info();
		remote = metadata.remote;
		const minted = await repo.createToken(scope, 300);
		artifactsToken = minted.plaintext;
	} catch {
		return new Response('Repository not found', { status: 404 });
	}

	const target = `${remote}/${gitPath}${url.search}`;
	const headers = new Headers(request.headers);
	headers.delete('host');
	headers.delete('cookie');
	headers.set('Authorization', `Bearer ${artifactsToken}`);

	const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
	const init: RequestInit & { duplex?: 'half' } = { method: request.method, headers, redirect: 'manual' };
	if (hasBody) {
		init.body = request.body;
		init.duplex = 'half';
	}
	return fetch(target, init);
}
