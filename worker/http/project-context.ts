export const PROJECT_ROOT = '/project';

export function parseProjectRoute(path: string): { projectId: string; subPath: string } | undefined {
	const match = path.match(/^\/p\/([a-z\d]{1,50})(\/.*)$/);
	if (match) {
		return { projectId: match[1], subPath: match[2] };
	}
	const exactMatch = path.match(/^\/p\/([a-z\d]{1,50})$/);
	if (exactMatch) {
		return { projectId: exactMatch[1], subPath: '/' };
	}
	return undefined;
}
