/**
 * Helpers for interacting with the Cloudflare Artifacts binding.
 *
 * IDE project repositories live in the `ide` namespace (configured on the
 * `ARTIFACTS` binding in wrangler.jsonc) with the repository name equal to the
 * project ID. Project IDs are `[a-z0-9]+`, which satisfies the Artifacts repo
 * naming rules (start with a letter/digit; letters, digits, `.`, `_`, `-`).
 */

/** Map a project ID to its Artifacts repository name. */
export function repoNameForProject(projectId: string): string {
	return projectId;
}

function isArtifactsErrorCode(error: unknown, code: string): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

/**
 * Strip the `?expires=...` suffix from an Artifacts token, returning the bare
 * secret used as the password in Git Basic auth.
 */
function tokenSecret(token: string): string {
	const queryIndex = token.indexOf('?');
	return queryIndex === -1 ? token : token.slice(0, queryIndex);
}

/**
 * Return a handle to the project's Artifacts repo, creating it (with default
 * branch `main`) if it does not yet exist.
 */
export async function ensureArtifactsRepo(
	environment: Pick<Env, 'ARTIFACTS'>,
	projectId: string,
): Promise<{ name: string; remote: string }> {
	const name = repoNameForProject(projectId);
	try {
		using repo = await environment.ARTIFACTS.get(name);
		const metadata = await repo.info();
		return { name: metadata.name, remote: metadata.remote };
	} catch {
		// The repo does not exist (or get is momentarily unavailable). Try to
		// create it; if creation races/fails because it now exists, re-get.
		try {
			const created = await environment.ARTIFACTS.create(name, { setDefaultBranch: 'main' });
			return { name: created.name, remote: created.remote };
		} catch (createError) {
			try {
				using repo = await environment.ARTIFACTS.get(name);
				const metadata = await repo.info();
				return { name: metadata.name, remote: metadata.remote };
			} catch {
				throw createError;
			}
		}
	}
}

/**
 * Mint a short-lived, repo-scoped Artifacts token. Returns the bare token
 * secret (suitable for Git Basic auth) and its ISO 8601 expiry.
 */
export async function mintArtifactsToken(
	environment: Pick<Env, 'ARTIFACTS'>,
	projectId: string,
	scope: 'read' | 'write',
	ttlSeconds = 300,
): Promise<{ secret: string; expiresAt: string }> {
	using repo = await environment.ARTIFACTS.get(repoNameForProject(projectId));
	const token = await repo.createToken(scope, ttlSeconds);
	return { secret: tokenSecret(token.plaintext), expiresAt: token.expiresAt };
}

/** Delete the project's Artifacts repo. Returns false if it did not exist. */
export async function deleteArtifactsRepo(environment: Env, projectId: string): Promise<boolean> {
	try {
		return await environment.ARTIFACTS.delete(repoNameForProject(projectId));
	} catch (error) {
		if (isArtifactsErrorCode(error, 'NOT_FOUND')) return false;
		throw error;
	}
}
