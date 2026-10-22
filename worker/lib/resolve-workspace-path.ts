import { computerPath, projectPath } from './computer-workspace';

import type { WorkspaceLike } from './workspace-fs-adapter';

/** Resolve parent and optional final symlinks, including missing write destinations. */
export async function resolveWorkspacePath(workspace: WorkspaceLike, path: string, followFinalLink = true): Promise<string> {
	let target = projectPath(computerPath(path));
	let links = 0;
	for (;;) {
		const components = target.split('/').filter(Boolean);
		let parent = '';
		let redirected = false;
		for (const [index, component] of components.entries()) {
			const current = `${parent}/${component}`;
			const entry = await workspace.lstat(current);
			if (entry?.type === 'symlink' && (followFinalLink || index < components.length - 1)) {
				if (++links > 40) throw new Error(`ELOOP: ${path}`);
				const link = await workspace.readlink(current);
				const destination = link.startsWith('/') ? link : `${parent}/${link}`;
				target = projectPath(computerPath(`${destination}/${components.slice(index + 1).join('/')}`));
				redirected = true;
				break;
			}
			if (!entry) return target;
			parent = current;
		}
		if (!redirected) return target;
	}
}
