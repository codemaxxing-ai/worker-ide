import type { FixFileFailure, ServerLintDiagnostic, ServerFixResult } from '@shared/biome-types';

const LINTABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.css', '.json']);

function isLintableFile(filePath: string): boolean {
	const extension = filePath.slice(filePath.lastIndexOf('.'));
	return LINTABLE_EXTENSIONS.has(extension);
}

interface BiomeDiagnosticResult {
	description: string;
	severity: string;
	category?: string;
	location?: { span?: [number, number]; sourceCode?: string };
	message?: Array<{ content: string }>;
	tags: string[];
}

interface BiomeApi {
	lintContent: (
		projectKey: number,
		content: string,
		options: { filePath: string; fixFileMode?: 'safeFixes' | 'safeAndUnsafeFixes' },
	) => {
		content: string;
		diagnostics: BiomeDiagnosticResult[];
	};
	formatContent: (
		projectKey: number,
		content: string,
		options: { filePath: string },
	) => {
		content: string;
		diagnostics: BiomeDiagnosticResult[];
	};
}

interface BiomeAction {
	suggestion?: {
		span: [number, number];
		suggestion: BiomeTextEdit;
	};
	category?: { quickFix?: string };
	ruleName?: string[];
}

type TextRange = [number, number];

type DiffOp = { equal: { range: TextRange } } | { insert: { range: TextRange } } | { delete: { range: TextRange } };

type CompressedOp = { diffOp: DiffOp } | { equalLines: { line_count: number } };

interface BiomeTextEdit {
	dictionary: string;
	ops: CompressedOp[];
}

interface BiomeWorkspace {
	openFile: (options: { projectKey: number; content: { type: string; content: string; version: number }; path: string }) => void;
	closeFile: (options: { projectKey: number; path: string }) => void;
	pullDiagnostics: (options: { projectKey: number; path: string; categories: string[] }) => {
		diagnostics: BiomeDiagnosticResult[];
	};
	pullActions: (options: { projectKey: number; path: string; range?: [number, number]; categories?: string[] }) => {
		actions: BiomeAction[];
	};
}

let initPromise: Promise<void> | undefined;
let initFailed = false;
let storedProjectKey: number | undefined;
let biomeApi: BiomeApi | undefined;
let biomeWorkspace: BiomeWorkspace | undefined;

async function ensureBiome(): Promise<boolean> {
	if (initFailed) return false;
	if (!initPromise) {
		initPromise = initBiome();
	}
	try {
		await initPromise;
		return true;
	} catch {
		initFailed = true;
		initPromise = undefined;
		return false;
	}
}

async function initBiome(): Promise<void> {
	// In the Cloudflare Workers runtime, `.wasm` imports are pre-compiled at
	// deploy time and resolve to a WebAssembly.Module.
	const { default: biomeWasm } = await import('../../vendor/biome_wasm_bg.wasm');
	const wasmModule = await import('@biomejs/wasm-web');
	await wasmModule.default({ module_or_path: biomeWasm });

	const { Biome, Distribution } = await import('@biomejs/js-api');
	const biome = await Biome.create({ distribution: Distribution.WEB });

	const project = biome.openProject();
	storedProjectKey = project.projectKey;

	biome.applyConfiguration(storedProjectKey, {
		linter: {
			enabled: true,
		},
		formatter: {
			enabled: true,
		},
	});

	// Store the high-level API for lintContent + formatContent (used by fixFile)
	biomeApi = biome;

	// Extract the workspace reference for direct pullDiagnostics calls.
	// The `workspace` property is private on BiomeCommon but exists at runtime.
	const descriptor = Object.getOwnPropertyDescriptor(biome, 'workspace');
	if (descriptor?.value) {
		biomeWorkspace = descriptor.value;
	}
}

function mapDiagnosticSeverity(severity: string): ServerLintDiagnostic['severity'] {
	switch (severity) {
		case 'error':
		case 'fatal': {
			return 'error';
		}
		default: {
			return 'warning';
		}
	}
}

function offsetToLineAndColumn(content: string, offset: number): { line: number; column: number } {
	let line = 1;
	let lastNewlineIndex = -1;
	for (let index = 0; index < offset && index < content.length; index++) {
		if (content[index] === '\n') {
			line++;
			lastNewlineIndex = index;
		}
	}
	const column = offset - lastNewlineIndex;
	return { line, column };
}

function pullDiagnosticsAndActions(
	key: number,
	filePath: string,
	content: string,
): { diagnostics: BiomeDiagnosticResult[]; fixableRules: Set<string> } {
	if (!biomeWorkspace) {
		return { diagnostics: [], fixableRules: new Set() };
	}
	biomeWorkspace.openFile({
		projectKey: key,
		content: { type: 'fromClient', content, version: 0 },
		path: filePath,
	});
	try {
		const { diagnostics } = biomeWorkspace.pullDiagnostics({
			projectKey: key,
			path: filePath,
			categories: ['syntax', 'lint'],
		});
		const { actions } = biomeWorkspace.pullActions({
			projectKey: key,
			path: filePath,
		});
		const fixableRules = new Set<string>();
		for (const action of actions) {
			if (action.category?.quickFix && action.ruleName) {
				fixableRules.add(`lint/${action.ruleName.join('/')}`);
			}
		}
		return { diagnostics, fixableRules };
	} finally {
		biomeWorkspace.closeFile({ projectKey: key, path: filePath });
	}
}

function mapDiagnostics(diagnostics: BiomeDiagnosticResult[], content: string, fixableRules?: Set<string>): ServerLintDiagnostic[] {
	return diagnostics.map((diagnostic) => {
		const span = diagnostic.location?.span;
		const from = span ? span[0] : 0;
		const to = span ? span[1] : from + 1;
		const { line, column } = span ? offsetToLineAndColumn(content, from) : { line: 1, column: 1 };

		let message = diagnostic.description;
		if (!message && diagnostic.message && diagnostic.message.length > 0) {
			message = diagnostic.message.map((node) => node.content).join('');
		}

		const rule = diagnostic.category ?? 'biome';

		return {
			line,
			column,
			from,
			to: to > from ? to : from + 1,
			rule,
			message: message || 'Unknown lint issue',
			severity: mapDiagnosticSeverity(diagnostic.severity),
			fixable: fixableRules ? fixableRules.has(rule) : diagnostic.tags.includes('fixable'),
		};
	});
}

function* splitInclusive(text: string, delimiter: string): Generator<string> {
	let start = 0;
	let index = text.indexOf(delimiter, start);
	while (index !== -1) {
		yield text.slice(start, index + delimiter.length);
		start = index + delimiter.length;
		index = text.indexOf(delimiter, start);
	}
	if (start < text.length) {
		yield text.slice(start);
	}
}

function applyTextEdit(originalContent: string, edit: BiomeTextEdit): string {
	const { dictionary, ops } = edit;
	let result = '';
	let inputPosition = 0;

	for (const op of ops) {
		if ('equalLines' in op) {
			const input = originalContent.slice(inputPosition);
			const lineBreakCount = op.equalLines.line_count + 1;
			let consumed = 0;
			let linesFound = 0;
			for (const line of splitInclusive(input, '\n')) {
				if (linesFound >= lineBreakCount) break;
				result += line;
				consumed += line.length;
				linesFound++;
			}
			inputPosition += consumed;
		} else if ('diffOp' in op) {
			const diffOp = op.diffOp;
			if ('equal' in diffOp) {
				const [start, end] = diffOp.equal.range;
				result += dictionary.slice(start, end);
				inputPosition += end - start;
			} else if ('insert' in diffOp) {
				const [start, end] = diffOp.insert.range;
				result += dictionary.slice(start, end);
			} else if ('delete' in diffOp) {
				const [start, end] = diffOp.delete.range;
				inputPosition += end - start;
			}
		}
	}

	return result;
}

/**
 * Lint a file and return diagnostics.
 * Returns an empty array if the file type is unsupported or Biome is unavailable.
 */
export async function lintFile(filePath: string, content: string): Promise<ServerLintDiagnostic[]> {
	if (!isLintableFile(filePath)) return [];

	const ready = await ensureBiome();
	if (!ready || storedProjectKey === undefined || !biomeWorkspace) return [];

	try {
		const { diagnostics, fixableRules } = pullDiagnosticsAndActions(storedProjectKey, filePath, content);
		return mapDiagnostics(diagnostics, content, fixableRules);
	} catch {
		return [];
	}
}

/**
 * Format and apply lint fixes to a file using Biome WASM.
 *
 * Runs the Biome formatter first (indentation, spacing, line length, etc.)
 * then applies all safe + unsafe lint auto-fixes on the formatted output.
 *
 * Returns the fixed content and remaining diagnostics, or a failure object
 * with a human-readable reason when the operation cannot be performed.
 */
export async function fixFile(filePath: string, content: string): Promise<ServerFixResult | FixFileFailure> {
	if (!isLintableFile(filePath)) {
		return { failed: true, reason: `File type not supported for fixing: ${filePath}` };
	}

	const ready = await ensureBiome();
	if (!ready || storedProjectKey === undefined || !biomeApi) {
		return { failed: true, reason: 'Biome failed to initialize' };
	}

	try {
		// Step 1: Format the content (indentation, spacing, trailing commas, etc.)
		const formatted = biomeApi.formatContent(storedProjectKey, content, { filePath });

		// Step 2: Apply all lint auto-fixes on the formatted content
		const linted = biomeApi.lintContent(storedProjectKey, formatted.content, {
			filePath,
			fixFileMode: 'safeAndUnsafeFixes',
		});

		// Step 3: Re-lint the final content to get remaining diagnostics
		const remaining = biomeApi.lintContent(storedProjectKey, linted.content, { filePath });
		const remainingDiagnostics = mapDiagnostics(remaining.diagnostics, linted.content);

		// Count how many lint diagnostics were fixed (formatting changes are not counted)
		const originalLintResult = biomeApi.lintContent(storedProjectKey, content, { filePath });
		const fixCount = originalLintResult.diagnostics.length - remainingDiagnostics.length;

		return {
			fixedContent: linted.content,
			fixCount: Math.max(fixCount, 0),
			remainingDiagnostics,
		};
	} catch (error) {
		return { failed: true, reason: `Biome threw an error: ${error instanceof Error ? error.message : String(error)}` };
	}
}

export async function applySingleFix(filePath: string, content: string, from: number, to: number): Promise<string | undefined> {
	if (!isLintableFile(filePath)) return undefined;

	const ready = await ensureBiome();
	if (!ready || storedProjectKey === undefined || !biomeWorkspace) return undefined;

	try {
		biomeWorkspace.openFile({
			projectKey: storedProjectKey,
			content: { type: 'fromClient', content, version: 0 },
			path: filePath,
		});

		try {
			const { actions } = biomeWorkspace.pullActions({
				projectKey: storedProjectKey,
				path: filePath,
				range: [from, to],
				categories: ['syntax', 'lint', 'action'],
			});

			// Pick the first quick-fix action that has an attached suggestion
			// AND whose span matches the requested diagnostic range. Falling back
			// to actions[0] would risk applying an unrelated refactor (e.g.
			// organizeImports) that happened to overlap the range.
			const action =
				actions.find((candidate) => {
					if (!candidate.suggestion) return false;
					if (!candidate.category?.quickFix) return false;
					const [actionFrom, actionTo] = candidate.suggestion.span;
					return actionFrom === from && actionTo === to;
				}) ?? actions.find((candidate) => candidate.suggestion && candidate.category?.quickFix);
			if (!action?.suggestion) return undefined;

			return applyTextEdit(content, action.suggestion.suggestion);
		} finally {
			biomeWorkspace.closeFile({ projectKey: storedProjectKey, path: filePath });
		}
	} catch (error) {
		console.warn('[biome-worker] applySingleFix failed:', error);
		return undefined;
	}
}
