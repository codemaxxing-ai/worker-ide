import { getPreviewUpdateTargets, isPreviewHotUpdatePath } from '../preview-path';
import { type CursorPosition, type SelectionRange } from './file-system';

import type { PreviewUpdateTarget } from '../preview-path';

export interface Participant {
	id: string;
	color: string;
	file?: string;
	cursor?: CursorPosition;
	selection?: SelectionRange;
}
export interface HmrUpdate {
	type: 'update' | 'full-reload';
	path: string;
	timestamp: number;
	targets: PreviewUpdateTarget[];
}

/**
 * Create an HmrUpdate for a file content change (write, edit, lint-fix).
 *
 * Determines whether the change can be applied as a hot update or requires
 * a full page reload based on the file extension:
 * - CSS files → hot updates for linked stylesheets and imported css modules
 * - JS/TS/JSX/TSX/JSON/imported assets → graph-driven module hot updates
 * - Other files (HTML, config, unknown assets) → full page reload
 */
export function createHmrUpdateForFile(path: string): HmrUpdate {
	const normalizedPath = path.startsWith('/') ? path : `/${path}`;
	const targets = getPreviewUpdateTargets(normalizedPath);
	const isHmrCapable = isPreviewHotUpdatePath(normalizedPath) && targets.length > 0;

	return {
		type: isHmrCapable ? 'update' : 'full-reload',
		path: normalizedPath,
		timestamp: Date.now(),
		targets,
	};
}
export interface DependencyError {
	packageName: string;
	code: 'unregistered' | 'not-found' | 'resolve-failed';
	message: string;
}
export interface SourceLocation {
	file: string;
	line?: number;
	column?: number;
}
export interface ServerError {
	id: string;
	timestamp: number;
	type: 'bundle' | 'runtime';
	message: string;
	location?: SourceLocation;
	dependencyErrors?: DependencyError[];
}
export interface ServerLogEntry {
	type: 'server-log';
	timestamp: number;
	level: 'log' | 'warning' | 'error' | 'debug' | 'info';
	message: string;
	location?: SourceLocation;
}
