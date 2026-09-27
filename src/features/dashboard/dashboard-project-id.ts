/**
 * Extract a project ID from various input formats:
 * - Full URL: https://anything.dev/p/<id>
 * - Path: /p/<id>
 * - Bare ID: <id>
 */
function extractProjectId(input: string): string | undefined {
	const pathMatch = input.match(/\/p\/([a-z\d]{1,50})(?:[/?#]|$)/);
	if (pathMatch) return pathMatch[1];
	const bareMatch = input.match(/^([a-z\d]{1,50})$/);
	if (bareMatch) return bareMatch[1];
	return undefined;
}

export { extractProjectId };
