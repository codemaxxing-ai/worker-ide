export function buildSeedFiles(files: Record<string, string>, projectName: string): Array<{ path: string; content: string }> {
	const seedFiles: Array<{ path: string; content: string }> = [];

	for (const [filePath, content] of Object.entries(files)) {
		if (filePath === 'package.json') {
			const packageJson: Record<string, unknown> = JSON.parse(content);
			packageJson.name = projectName;
			seedFiles.push({ path: '/package.json', content: JSON.stringify(packageJson, undefined, '\t') + '\n' });
		} else {
			seedFiles.push({ path: `/${filePath}`, content });
		}
	}

	seedFiles.push({ path: '/.initialized', content: '1' });

	return seedFiles;
}
