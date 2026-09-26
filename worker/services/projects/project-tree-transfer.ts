interface ProjectTreeFile {
	path: string;
	content: Uint8Array;
}

interface ProjectTreeSource {
	exportTree(): Promise<ProjectTreeFile[] & Disposable>;
}

interface ProjectTreeDestination {
	importTree(files: ReadonlyArray<ProjectTreeFile>): Promise<void>;
}

/** Release the RPC result after the destination has consumed the exported tree. */
export async function transferProjectTree(source: ProjectTreeSource, destination: ProjectTreeDestination): Promise<void> {
	using sourceTree = await source.exportTree();
	await destination.importTree(sourceTree);
}
