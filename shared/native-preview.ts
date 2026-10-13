export type NativePreviewSourceEntry =
	| { path: string; type: 'directory' }
	| { path: string; type: 'file'; contents: string }
	| { path: string; type: 'symlink'; target: string };
