/** Project filesystem metadata, independent of an execution backend. */
export interface WorkspaceFileInfo {
	path: string;
	name: string;
	type: 'file' | 'directory' | 'symlink';
	mimeType: string;
	size: number;
	createdAt: number;
	updatedAt: number;
	target?: string;
}
