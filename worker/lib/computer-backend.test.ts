import { describe, expect, it } from 'vitest';

import { selectComputerBackend } from './computer-backend';

describe('Computer backend selection', () => {
	it.each([
		'cat src/main.ts | grep TODO | wc -l',
		'git status --short; git diff -- src/main.ts',
		'git -C "$directory" status --short',
		'find src -name "*.ts"',
		'printf "bun run build"; echo \'$(node --version)\'',
		'for file in src/*.ts; do head -n 2 "$file"; done',
		'printf changed > source.txt',
	])('keeps supported text and file commands in the isolate: %s', (command) => {
		expect(selectComputerBackend(command)).toBe('shell');
	});
	it.each([
		'bun install',
		'NODE_ENV=production bun run build && cat dist/index.html',
		'echo $(node --version)',
		'cat input.txt | python3 transform.py',
		'env NODE_ENV=test bun test',
		'./node_modules/.bin/vite build',
		'curl https://example.com',
		'command="$RUNTIME"; "$command" script.js',
		'sh -c "bun run build"',
		'git fetch origin',
		'git -C /workspace push origin HEAD',
		'git rebase main',
		'git "$operation"',
		String.raw`printf "%s\n" src/*.ts | xargs node check.js`,
		'timeout 30 bun run build',
		String.raw`find src -exec node check.js {} \;`,
	])('selects native execution for the whole command before dispatch: %s', (command) => {
		expect(selectComputerBackend(command, 'auto')).toBe('container');
	});
	it('honors an explicit backend and rejects unknown selectors', () => {
		expect(selectComputerBackend('bun install', 'shell')).toBe('shell');
		expect(selectComputerBackend('cat source.txt', 'container')).toBe('container');
		expect(() => selectComputerBackend('true', 'invalid')).toThrow('Unsupported execution backend');
	});
});
