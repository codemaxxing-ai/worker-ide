import { createAuth } from '../lib/auth';

export async function resolveSessionFromRequest(
	request: Request,
	environment: Pick<
		Env,
		'DB' | 'BETTER_AUTH_SECRET' | 'GITHUB_CLIENT_ID' | 'GITHUB_CLIENT_SECRET' | 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET'
	>,
	baseUrl: string,
): Promise<{ sessionId: string; userId: string } | undefined> {
	if (import.meta.env.DEV) {
		const { resolveDevelopmentSession } = await import('../lib/development-session');
		const result = await resolveDevelopmentSession(environment.DB, request.headers);
		if (!result) {
			return undefined;
		}
		return { sessionId: result.session.id, userId: result.session.userId };
	}

	const auth = createAuth(environment, baseUrl);
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session) {
		return undefined;
	}

	return {
		sessionId: session.session.id,
		userId: session.user.id,
	};
}
