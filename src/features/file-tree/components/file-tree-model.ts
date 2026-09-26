import { PROTECTED_FILES } from '@shared/constants';

import type { GitStatus, GitStatusEntry } from '@pierre/trees';
import type { FileInfo, GitFileStatus, Participant } from '@shared/types';

// @pierre/trees uses canonical, leading-slash-free paths and marks directories
// with a trailing slash. The rest of the IDE uses leading-slash paths
// (e.g. "/src/main.ts") and the git status map uses no leading slash.

function toTreePath(storePath: string, isDirectory: boolean): string {
	const stripped = storePath.replace(/^\/+/, '');
	return isDirectory ? `${stripped}/` : stripped;
}

function toStorePath(treePath: string): string {
	const withoutTrailing = treePath.endsWith('/') ? treePath.slice(0, -1) : treePath;
	return `/${withoutTrailing}`;
}

function isProtectedTreePath(treePath: string): boolean {
	return PROTECTED_FILES.has(toStorePath(treePath));
}

function mapGitStatus(status: GitFileStatus | undefined): GitStatus | undefined {
	if (!status || status === 'unmodified') return undefined;

	switch (status) {
		case 'modified':
		case 'modified-staged':
		case 'modified-partially-staged': {
			return 'modified';
		}
		case 'untracked':
		case 'untracked-staged':
		case 'untracked-partially-staged': {
			return 'untracked';
		}
		case 'deleted':
		case 'deleted-staged': {
			return 'deleted';
		}
		default: {
			return undefined;
		}
	}
}

// Collaborator presence is shown as small, per-user-colored dots in the row's
// decoration lane. The lane only accepts a single icon, so we synthesize one
// sprite symbol per distinct color-combination currently present and reference
// it per file. Stacking is capped so a busy file renders predictably.
const PRESENCE_DOT_RADIUS = 3.5;
const PRESENCE_DOT_STEP = 4.5; // horizontal offset between overlapping dots
const PRESENCE_MAX_DOTS = 3;
const PRESENCE_DISPLAY_HEIGHT = 9; // rendered px height of the indicator

interface PresenceIcon {
	name: string;
	width: number;
	height: number;
	viewBox: string;
	count: number;
}

function buildPresence(participants: Participant[]): { spriteSheet: string; byFile: Map<string, PresenceIcon> } {
	const colorsByFile = new Map<string, string[]>();
	for (const participant of participants) {
		if (!participant.file) continue;
		const list = colorsByFile.get(participant.file) ?? [];
		list.push(participant.color);
		colorsByFile.set(participant.file, list);
	}

	const symbolMarkupById = new Map<string, string>();
	const idByCombo = new Map<string, string>();
	const byFile = new Map<string, PresenceIcon>();

	for (const [file, colors] of colorsByFile) {
		const capped = colors.slice(0, PRESENCE_MAX_DOTS);
		const comboKey = capped.join('|');
		let id = idByCombo.get(comboKey);
		const intrinsicWidth = PRESENCE_DOT_RADIUS * 2 + (capped.length - 1) * PRESENCE_DOT_STEP;
		const intrinsicHeight = PRESENCE_DOT_RADIUS * 2;
		const viewBox = `0 0 ${intrinsicWidth} ${intrinsicHeight}`;
		if (!id) {
			id = `presence-${idByCombo.size}`;
			idByCombo.set(comboKey, id);
			const circles = capped
				.map(
					(color, index) =>
						`<circle cx="${PRESENCE_DOT_RADIUS + index * PRESENCE_DOT_STEP}" cy="${PRESENCE_DOT_RADIUS}" r="${PRESENCE_DOT_RADIUS}" fill="${color}" stroke="var(--color-bg-secondary)" stroke-width="0.75" />`,
				)
				.join('');
			symbolMarkupById.set(id, `<symbol id="${id}" viewBox="${viewBox}">${circles}</symbol>`);
		}
		byFile.set(file, {
			name: id,
			viewBox,
			height: PRESENCE_DISPLAY_HEIGHT,
			width: (intrinsicWidth / intrinsicHeight) * PRESENCE_DISPLAY_HEIGHT,
			count: colors.length,
		});
	}

	const spriteSheet =
		symbolMarkupById.size > 0 ? `<svg xmlns="http://www.w3.org/2000/svg">${[...symbolMarkupById.values()].join('')}</svg>` : '';
	return { spriteSheet, byFile };
}

function buildGitStatus(files: FileInfo[], gitStatusMap: Map<string, GitFileStatus> | undefined): GitStatusEntry[] {
	if (!gitStatusMap) return [];
	const entries: GitStatusEntry[] = [];
	for (const file of files) {
		if (file.isDirectory) continue;
		const key = file.path.startsWith('/') ? file.path.slice(1) : file.path;
		const status = mapGitStatus(gitStatusMap.get(key));
		if (status) {
			entries.push({ path: key, status });
		}
	}
	return entries;
}

export { buildGitStatus, buildPresence, isProtectedTreePath, toStorePath, toTreePath, type PresenceIcon };
