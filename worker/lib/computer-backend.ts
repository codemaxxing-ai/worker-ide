import { Bash, getCommandNames } from 'just-bash';

export type ComputerBackend = 'shell' | 'container';

const SHELL_COMMANDS = new Set([
	...getCommandNames().filter(
		(name) =>
			![
				'curl',
				'wget',
				'python',
				'python3',
				'js-exec',
				'sqlite3',
				'env',
				'command',
				'eval',
				'source',
				'.',
				'sh',
				'bash',
				'xargs',
				'timeout',
				'time',
			].includes(name),
	),
	'git',
	'cd',
	'export',
	'unset',
	'set',
	'echo',
	'printf',
	'true',
	'false',
	'test',
	'[',
	'pwd',
	'read',
	'break',
	'continue',
	'return',
	'exit',
]);
const LOCAL_GIT_COMMANDS = new Set([
	'help',
	'--help',
	'-h',
	'version',
	'--version',
	'diff',
	'init',
	'status',
	'add',
	'rm',
	'commit',
	'log',
	'show',
	'rev-parse',
	'symbolic-ref',
	'ls-files',
	'ls-tree',
	'branch',
	'tag',
	'checkout',
	'switch',
	'merge',
	'remote',
	'hash-object',
	'cat-file',
	'update-ref',
	'config',
	'stash',
	'reset',
	'clean',
]);
let parser: Bash | undefined;

function literalWord(value: unknown): string | undefined {
	if (!value || typeof value !== 'object') return undefined;
	if ('type' in value && value.type === 'Literal' && 'value' in value && typeof value.value === 'string') return value.value;
	if (!('parts' in value) || !Array.isArray(value.parts)) return undefined;
	const parts = value.parts.map((part) => literalWord(part));
	return parts.every((part) => part !== undefined) ? parts.join('') : undefined;
}

function requiresContainer(value: unknown): boolean {
	if (!value || typeof value !== 'object') return false;
	if (Array.isArray(value)) return value.some((part) => requiresContainer(part));
	if ('type' in value && value.type === 'SimpleCommand' && 'name' in value && value.name) {
		const name = literalWord(value.name);
		if (!name || !SHELL_COMMANDS.has(name)) return true;
		const argumentsValue = 'args' in value && Array.isArray(value.args) ? value.args.map((argument) => literalWord(argument)) : [];
		if (name === 'git') {
			const command = argumentsValue[argumentsValue[0] === '-C' ? 2 : 0];
			if (argumentsValue.length > 0 && (command === undefined || !LOCAL_GIT_COMMANDS.has(command))) return true;
		}
		if (
			name === 'find' &&
			argumentsValue.some((argument) => argument !== undefined && ['-exec', '-execdir', '-ok', '-okdir'].includes(argument))
		)
			return true;
	}
	return Object.values(value).some((part) => requiresContainer(part));
}

/** Select before dispatch; failed or interrupted commands are never replayed on another backend. */
export function selectComputerBackend(command: string, requested?: string): ComputerBackend {
	if (requested === 'shell' || requested === 'container') return requested;
	if (requested !== undefined && requested !== 'auto') throw new Error(`Unsupported execution backend: ${requested}`);
	try {
		parser ??= new Bash({ commands: [] });
		return requiresContainer(parser.transform(command).ast) ? 'container' : 'shell';
	} catch {
		// Native Bash handles syntax the isolate parser cannot represent.
		return 'container';
	}
}
