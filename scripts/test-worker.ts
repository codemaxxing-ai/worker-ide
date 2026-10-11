import { spawn } from 'node:child_process';
import { globSync, readFileSync } from 'node:fs';

/** Keep the preview engine's bundled modules below workerd's per-isolate heap limit. */
const argumentsValue = process.argv.slice(2);
const run = argumentsValue.includes('--run');
const filters = argumentsValue.filter((argument) => !argument.startsWith('-'));

async function invoke(files: string[]): Promise<number> {
	const subprocess = spawn('bunx', ['vitest', '--project', 'worker', '--maxWorkers=1', ...argumentsValue, ...files], { stdio: 'inherit' });
	return new Promise<number>((resolve) => {
		subprocess.once('error', (error) => {
			console.error(error);
			resolve(1);
		});
		subprocess.once('exit', (code) => resolve(code ?? 1));
	});
}

async function main(): Promise<number> {
	if (!run || filters.length > 0) return invoke([]);
	const files = globSync('worker/**/*.test.ts')
		.filter((file) => !file.startsWith('worker/fixtures/'))
		.toSorted();
	const isolatedFiles = files.filter(
		(file) => (file.includes('/vite-host/') && file.endsWith('.integration.test.ts')) || readFileSync(file, 'utf8').includes('env.DB'),
	);
	const ordinary = files.filter((file) => !isolatedFiles.includes(file));
	const batches: string[][] = [];
	for (let index = 0; index < ordinary.length; index += 16) batches.push(ordinary.slice(index, index + 16));
	for (const file of isolatedFiles) batches.push([file]);
	let failed = false;
	for (const [index, batch] of batches.entries()) {
		console.info(`Worker test batch ${index + 1}/${batches.length} (${batch.length} files)`);
		if ((await invoke(batch)) !== 0) failed = true;
	}
	return failed ? 1 : 0;
}
process.exitCode = await main();
