export interface FileInfo {
	path: string;
	name: string;
	isDirectory: boolean;
}
export interface FileTreeNode {
	path: string;
	name: string;
	isDirectory: boolean;
	children?: FileTreeNode[];
	level: number;
}
export interface OpenFile {
	path: string;
	content: string;
	isDirty: boolean;
	cursor?: CursorPosition;
}
export interface CursorPosition {
	line: number;
	ch: number;
}
export interface SelectionRange {
	anchor: CursorPosition;
	head: CursorPosition;
}
