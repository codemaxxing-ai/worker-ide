import { env } from 'cloudflare:workers';
import { minimatch } from 'minimatch';

import { HIDDEN_ENTRIES, WORKERS_COMPATIBILITY_DATE } from '@shared/constants';
import { parseJsonc } from '@shared/jsonc';
import { ToolExecutionError } from '@shared/tool-errors';
import { fs } from '@worker/lib/project-fs';

import { listFilesRecursive } from '../tool-executor';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext, ToolResult } from '../types';

const MAX_TEST_FILES = 20;
const TEST_TIMEOUT_MS = 30_000;
const DEFAULT_GLOB = 'test/**/*.test.{js,ts,jsx,tsx}';

const DESCRIPTION = `Run JavaScript/TypeScript tests in a sandboxed Worker isolate. Tests use a built-in test harness with describe/it/expect — no extra dependencies are needed.

Granularity:
- Run ALL tests: omit both parameters (defaults to "test/**/*.test.{js,ts,jsx,tsx}").
- Run a SPECIFIC FILE: set pattern to a file path (e.g., pattern: "test/math.test.ts").
- Run a GLOB of files: set pattern to a glob (e.g., pattern: "test/**/*.spec.ts").
- Run a SINGLE TEST: set testName to the full test name (e.g., testName: "add > adds two positive numbers"). Combine with pattern to target the file containing the test for faster execution.

Usage:
- Tests can import project source files (e.g., import { add } from '../src/math.ts').
- The test harness provides describe(), it(), and expect() globally — no imports needed in test files.
- expect(value) supports: .toBe(), .toEqual(), .toBeTruthy(), .toBeFalsy(), .toBeUndefined(), .toBeNull(), .toContain(), .toThrow(), .toHaveLength(), .toBeGreaterThan(), .toBeLessThan(), .toMatch(), and .not for negation.
- Tests run server-side in an isolated V8 sandbox (Cloudflare WorkerLoader), not in the browser.
- This tool does not run Vitest, read vitest.config.ts, or provide a DOM or Vitest APIs such as vi.mock. For React/DOM or full Vitest tests, use exec with backend "container". Register missing packages through dependencies_update, add // @vitest-environment jsdom (or happy-dom) to each DOM test file, and run bun run test -- <test-file>. Prefer an already registered DOM environment. Investigate window/document-is-not-defined errors, add the matching per-file directive, and rerun affected tests. Install registered dependencies with bun install only if required native tests need missing container packages. A failed check is not completed verification; do not label it pre-existing without baseline evidence. Leave the protected vitest.config.ts unchanged.
- Each test file runs independently. Results include pass/fail counts and error details.

Example test file (test/math.test.ts):
\`\`\`ts
import { add, multiply } from '../src/math.ts';

describe('add', () => {
  it('adds two positive numbers', () => {
    expect(add(1, 2)).toBe(3);
  });

  it('handles negative numbers', () => {
    expect(add(-1, 1)).toBe(0);
  });
});

describe('multiply', () => {
  it('multiplies two numbers', () => {
    expect(multiply(3, 4)).toBe(12);
  });
});
\`\`\``;

export const definition: ToolDefinition = {
	name: 'test_run',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {
			pattern: {
				type: 'string',
				description:
					'Glob pattern or file path for test files. Defaults to "test/**/*.test.{js,ts,jsx,tsx}". Examples: "test/math.test.ts", "test/**/*.test.ts", "src/**/*.spec.ts".',
			},
			testName: {
				type: 'string',
				description:
					'Run a single test by its full name (e.g., "add > adds two positive numbers"). When provided, only the matching test is executed. The name must match exactly as shown in test results, using " > " to separate suite and test names. Combine with pattern to target the specific file for faster execution.',
			},
		},
	},
};

/**
 * Minimal test runtime injected into every test bundle.
 * Provides describe(), it(), and expect() — runs entirely in a Worker isolate.
 *
 * The harness collects test registrations synchronously, then runs them
 * asynchronously (supporting async test functions) and stores results on
 * `globalThis.__TEST_RESULTS__`.
 */
const TEST_HARNESS_SOURCE = `
const __suites = [];
let __currentSuite = null;

globalThis.describe = function describe(name, fn) {
  const suite = { name, tests: [], beforeEachFns: [], afterEachFns: [] };
  const parentSuite = __currentSuite;
  __currentSuite = suite;
  fn();
  __currentSuite = parentSuite;
  if (parentSuite) {
    // Nested describe: flatten into parent with prefixed names
    for (const test of suite.tests) {
      parentSuite.tests.push({ name: name + ' > ' + test.name, fn: test.fn });
    }
  } else {
    __suites.push(suite);
  }
};

globalThis.it = function it(name, fn) {
  if (__currentSuite) {
    __currentSuite.tests.push({ name, fn });
  } else {
    // Top-level it (no describe)
    __suites.push({ name: '(top-level)', tests: [{ name, fn }], beforeEachFns: [], afterEachFns: [] });
  }
};

// Aliases
globalThis.test = globalThis.it;

// ── Expect ────────────────────────────────────────────────────────────────────
function formatValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  try { return JSON.stringify(value); } catch { return String(value); }
}

function createExpect(actual, negated) {
  const assert = (pass, message) => {
    const finalPass = negated ? !pass : pass;
    if (!finalPass) throw new Error(negated ? 'Expected not: ' + message : message);
  };

  const matchers = {
    toBe(expected) {
      assert(actual === expected, 'Expected ' + formatValue(actual) + ' to be ' + formatValue(expected));
    },
    toEqual(expected) {
      const a = JSON.stringify(actual);
      const b = JSON.stringify(expected);
      assert(a === b, 'Expected ' + formatValue(actual) + ' to equal ' + formatValue(expected));
    },
    toBeTruthy() {
      assert(!!actual, 'Expected ' + formatValue(actual) + ' to be truthy');
    },
    toBeFalsy() {
      assert(!actual, 'Expected ' + formatValue(actual) + ' to be falsy');
    },
    toBeUndefined() {
      assert(actual === undefined, 'Expected ' + formatValue(actual) + ' to be undefined');
    },
    toBeNull() {
      assert(actual === null, 'Expected ' + formatValue(actual) + ' to be null');
    },
    toBeDefined() {
      assert(actual !== undefined, 'Expected value to be defined');
    },
    toContain(item) {
      if (typeof actual === 'string') {
        assert(actual.includes(item), 'Expected ' + formatValue(actual) + ' to contain ' + formatValue(item));
      } else if (Array.isArray(actual)) {
        assert(actual.includes(item), 'Expected array to contain ' + formatValue(item));
      } else {
        throw new Error('toContain requires a string or array');
      }
    },
    toHaveLength(expected) {
      const length = actual && actual.length;
      assert(length === expected, 'Expected length ' + length + ' to be ' + expected);
    },
    toBeGreaterThan(expected) {
      assert(actual > expected, 'Expected ' + actual + ' to be greater than ' + expected);
    },
    toBeLessThan(expected) {
      assert(actual < expected, 'Expected ' + actual + ' to be less than ' + expected);
    },
    toBeGreaterThanOrEqual(expected) {
      assert(actual >= expected, 'Expected ' + actual + ' to be >= ' + expected);
    },
    toBeLessThanOrEqual(expected) {
      assert(actual <= expected, 'Expected ' + actual + ' to be <= ' + expected);
    },
    toMatch(pattern) {
      const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
      assert(regex.test(actual), 'Expected ' + formatValue(actual) + ' to match ' + String(pattern));
    },
    toThrow(expectedMessage) {
      let threw = false;
      let thrownError;
      try {
        if (typeof actual !== 'function') throw new Error('toThrow requires a function');
        actual();
      } catch (error) {
        threw = true;
        thrownError = error;
      }
      assert(threw, 'Expected function to throw');
      if (expectedMessage && threw) {
        const message = thrownError instanceof Error ? thrownError.message : String(thrownError);
        if (typeof expectedMessage === 'string') {
          assert(message.includes(expectedMessage), 'Expected throw message to include ' + formatValue(expectedMessage) + ', got ' + formatValue(message));
        } else if (expectedMessage instanceof RegExp) {
          assert(expectedMessage.test(message), 'Expected throw message to match ' + String(expectedMessage) + ', got ' + formatValue(message));
        }
      }
    },
    toBeInstanceOf(expected) {
      assert(actual instanceof expected, 'Expected value to be instance of ' + (expected.name || expected));
    },
    get not() {
      return createExpect(actual, !negated);
    },
  };

  return matchers;
}

globalThis.expect = function expect(actual) {
  return createExpect(actual, false);
};

// ── Runner ────────────────────────────────────────────────────────────────────
globalThis.__runTests = async function __runTests(testNameFilter) {
  const results = { suites: [], passed: 0, failed: 0, total: 0, duration: 0 };
  const startTime = Date.now();

  for (const suite of __suites) {
    const suiteResult = { name: suite.name, tests: [], passed: 0, failed: 0 };

    for (const test of suite.tests) {
      // When a filter is provided, skip tests that don't match
      if (testNameFilter) {
        const fullName = suite.name === '(top-level)' ? test.name : suite.name + ' > ' + test.name;
        if (fullName !== testNameFilter) continue;
      }

      const testStart = Date.now();
      let status = 'passed';
      let error = undefined;

      try {
        const result = test.fn();
        // Support async test functions
        if (result && typeof result.then === 'function') {
          await result;
        }
      } catch (err) {
        status = 'failed';
        error = err instanceof Error ? err.message : String(err);
      }

      const testDuration = Date.now() - testStart;
      suiteResult.tests.push({ name: test.name, status, error, duration: testDuration });

      if (status === 'passed') {
        suiteResult.passed++;
        results.passed++;
      } else {
        suiteResult.failed++;
        results.failed++;
      }
      results.total++;
    }

    if (suiteResult.tests.length > 0) {
      results.suites.push(suiteResult);
    }
  }

  results.duration = Date.now() - startTime;
  return results;
};
`;

/**
 * Worker entry point wrapping: imports the test bundle, runs tests, returns JSON.
 * The harness + test code is prepended as a separate module that the entry point imports.
 */
function buildTestWorkerEntry(harnessModuleName: string, testFilePath: string): string {
	return [
		`import './${harnessModuleName}';`,
		`import './${testFilePath}';`,
		'',
		'export default {',
		'  async fetch(request) {',
		'    try {',
		'      const url = new URL(request.url);',
		'      const testNameFilter = url.searchParams.get("testName") || undefined;',
		'      const results = await globalThis.__runTests(testNameFilter);',
		'      return Response.json(results);',
		'    } catch (error) {',
		'      return Response.json({',
		'        suites: [],',
		'        passed: 0,',
		'        failed: 0,',
		'        total: 0,',
		'        duration: 0,',
		'        error: error instanceof Error ? error.message : String(error),',
		'      }, { status: 500 });',
		'    }',
		'  }',
		'};',
	].join('\n');
}

interface TestResult {
	name: string;
	status: 'passed' | 'failed';
	error?: string;
	duration: number;
}

interface SuiteResult {
	name: string;
	tests: TestResult[];
	passed: number;
	failed: number;
}

interface TestRunResults {
	suites: SuiteResult[];
	passed: number;
	failed: number;
	total: number;
	duration: number;
	error?: string;
}

export interface StructuredTestRunResult {
	title: string;
	output: string;
	metadata: {
		passed: number;
		failed: number;
		total: number;
		files: number;
		bundleErrors: number;
	};
	fileResults: Array<{ file: string; results: TestRunResults }>;
	bundleErrors: Array<{ file: string; error: string }>;
}

/**
 * Core test runner logic. Discovers test files, bundles and executes each one,
 * and returns structured results. Used by both the AI tool and the API route.
 */
export async function runTests(
	projectRoot: string,
	pattern: string = DEFAULT_GLOB,
	onStatus?: (message: string) => void,
	testName?: string,
	abortSignal?: AbortSignal,
): Promise<StructuredTestRunResult> {
	const report = (message: string) => onStatus?.(message);

	report(`Finding test files matching "${pattern}"...`);

	// Discover test files
	const testFiles = await discoverTestFiles(projectRoot, pattern);

	if (testFiles.length === 0) {
		throw new ToolExecutionError(
			'FILE_NOT_FOUND',
			`No test files found matching "${pattern}". Create test files (e.g., test/math.test.ts) and try again.`,
		);
	}

	if (testFiles.length > MAX_TEST_FILES) {
		throw new ToolExecutionError(
			'MISSING_INPUT',
			`Found ${testFiles.length} test files, but the maximum is ${MAX_TEST_FILES}. Use a more specific pattern to narrow down the test files.`,
		);
	}

	report(`Running ${testFiles.length} test file${testFiles.length === 1 ? '' : 's'}...`);

	// Collect all project source files for bundling
	const allFiles = await collectProjectFiles(projectRoot);

	// Read test file contents
	for (const testFile of testFiles) {
		const relativePath = testFile.startsWith('/') ? testFile.slice(1) : testFile;
		if (!(relativePath in allFiles)) {
			const content = await fs.readFile(`${projectRoot}${testFile}`, 'utf8');
			allFiles[relativePath] = content;
		}
	}

	// Load tsconfig for esbuild
	const tsconfigRaw = await loadTsconfigRaw(projectRoot);
	const knownDependencies = await loadKnownDependencies(projectRoot);

	// Run each test file
	const fileResults: Array<{ file: string; results: TestRunResults }> = [];
	let totalPassed = 0;
	let totalFailed = 0;
	let totalCount = 0;
	const bundleErrors: Array<{ file: string; error: string }> = [];

	for (const testFile of testFiles) {
		// Bail early between test files if the agent was cancelled
		if (abortSignal?.aborted) break;

		const relativePath = testFile.startsWith('/') ? testFile.slice(1) : testFile;
		report(`Running ${relativePath}...`);

		try {
			const results = await runSingleTestFile(relativePath, allFiles, tsconfigRaw, knownDependencies, testName, abortSignal);
			fileResults.push({ file: relativePath, results });
			totalPassed += results.passed;
			totalFailed += results.failed;
			totalCount += results.total;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			bundleErrors.push({ file: relativePath, error: message });
			totalFailed++;
			totalCount++;
		}
	}

	// Format output
	const output = formatTestOutput(fileResults, bundleErrors, totalPassed, totalFailed, totalCount);

	const allPassed = totalFailed === 0 && bundleErrors.length === 0;

	return {
		title: allPassed ? `${totalPassed} passed` : `${totalFailed} failed, ${totalPassed} passed`,
		output,
		metadata: {
			passed: totalPassed,
			failed: totalFailed,
			total: totalCount,
			files: testFiles.length,
			bundleErrors: bundleErrors.length,
		},
		fileResults,
		bundleErrors,
	};
}

export async function execute(
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
): Promise<ToolResult> {
	const result = await runTests(
		context.projectRoot,
		input.pattern,
		(message) => {
			sendEvent('status', { message });
		},
		input.testName,
		context.abortSignal,
	);

	return {
		title: result.title,
		metadata: result.metadata,
		output: result.output,
	};
}

async function discoverTestFiles(projectRoot: string, pattern: string): Promise<string[]> {
	// If the pattern looks like a specific file path (no wildcards), check if it exists
	if (!pattern.includes('*') && !pattern.includes('{')) {
		const filePath = pattern.startsWith('/') ? pattern : `/${pattern}`;
		try {
			await fs.access(`${projectRoot}${filePath}`);
			return [filePath];
		} catch {
			throw new ToolExecutionError('FILE_NOT_FOUND', `Test file not found: ${filePath}`);
		}
	}

	// Glob-based discovery
	const allFiles = await listFilesRecursive(projectRoot);
	const matched = allFiles.filter((filepath) => {
		const testPath = filepath.startsWith('/') ? filepath.slice(1) : filepath;
		return minimatch(testPath, pattern, { matchBase: true, dot: false }) || minimatch(filepath, pattern, { matchBase: true, dot: false });
	});

	return matched.slice(0, MAX_TEST_FILES);
}

async function collectProjectFiles(projectRoot: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {};

	async function walkDirectory(directory: string, base: string): Promise<void> {
		try {
			const entries = await fs.readdir(directory, { withFileTypes: true });
			const tasks = entries
				.filter((entry: { name: string }) => !HIDDEN_ENTRIES.has(entry.name))
				.map(async (entry: { name: string; isDirectory(): boolean }) => {
					const relativePath = base ? `${base}/${entry.name}` : entry.name;
					const fullPath = `${directory}/${entry.name}`;
					if (entry.isDirectory()) {
						await walkDirectory(fullPath, relativePath);
					} else {
						const extension = entry.name.slice(entry.name.lastIndexOf('.'));
						if (['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.json'].includes(extension)) {
							const content = await fs.readFile(fullPath, 'utf8');
							files[relativePath] = content;
						}
					}
				});
			await Promise.all(tasks);
		} catch {
			// Directory doesn't exist or read error
		}
	}

	await walkDirectory(projectRoot, '');
	return files;
}

async function loadTsconfigRaw(projectRoot: string): Promise<string | undefined> {
	try {
		const content = await fs.readFile(`${projectRoot}/tsconfig.json`, 'utf8');
		const parsed: { compilerOptions?: unknown } = parseJsonc(content);

		// If the root tsconfig is a solution-style project references file (no compilerOptions),
		// try loading tsconfig.app.json which has the frontend compiler settings (jsx, etc.)
		if (!parsed.compilerOptions) {
			try {
				return await fs.readFile(`${projectRoot}/tsconfig.app.json`, 'utf8');
			} catch {
				return undefined;
			}
		}

		return content;
	} catch {
		return undefined;
	}
}

async function loadKnownDependencies(projectRoot: string): Promise<Map<string, string>> {
	try {
		const raw = await fs.readFile(`${projectRoot}/package.json`, 'utf8');
		const packageJson: unknown = JSON.parse(raw);
		if (
			packageJson &&
			typeof packageJson === 'object' &&
			'dependencies' in packageJson &&
			packageJson.dependencies &&
			typeof packageJson.dependencies === 'object'
		) {
			const entries = Object.entries(packageJson.dependencies).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
			return new Map(entries);
		}
	} catch {
		// No package.json or parse error
	}
	return new Map();
}

async function runSingleTestFile(
	testFilePath: string,
	allFiles: Record<string, string>,
	tsconfigRaw: string | undefined,
	knownDependencies: Map<string, string>,
	testName?: string,
	abortSignal?: AbortSignal,
): Promise<TestRunResults> {
	// We use bundleWithCdn to bundle the test file and resolve imports (including CDN deps).
	// Imported lazily to avoid circular dependency at module load time.
	const { bundleWithCdn } = await import('../../bundler-client');

	// The entry point imports the harness module first (which sets up globalThis.describe
	// etc.), then imports the test file. ESM guarantees sequential evaluation of imports,
	// so the harness globals are available when the test file's top-level code runs.
	const harnessModuleName = '__test_harness__.js';
	const entryName = '__test_entry__.js';

	const entrySource = buildTestWorkerEntry(harnessModuleName, testFilePath);

	// Add virtual entry files to the file set
	const bundleFiles: Record<string, string> = {
		...allFiles,
		[harnessModuleName]: TEST_HARNESS_SOURCE,
		[entryName]: entrySource,
	};

	const bundled = await bundleWithCdn({
		files: bundleFiles,
		entryPoint: entryName,
		platform: 'neutral',
		tsconfigRaw,
		knownDependencies,
	});

	// Load and execute in a WorkerLoader isolate
	const contentHash = await hashString(bundled.code);
	const cacheKey = `test:${contentHash}`;

	const worker = env.LOADER.get(cacheKey, async () => ({
		compatibilityDate: WORKERS_COMPATIBILITY_DATE,
		mainModule: 'test-worker.js',
		modules: { 'test-worker.js': bundled.code },
		// Block outbound network access for test isolation
		// eslint-disable-next-line unicorn/no-null -- WorkerLoader uses null to disable outbound networking
		globalOutbound: null,
	}));

	const entrypoint = worker.getEntrypoint();

	// Execute with timeout, linked to the parent abort signal so
	// cancelling the agent also cancels the in-flight test.
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
	const onParentAbort = () => controller.abort();
	abortSignal?.addEventListener('abort', onParentAbort);

	try {
		const fetchUrl = testName ? `http://test-runner/?testName=${encodeURIComponent(testName)}` : 'http://test-runner/';
		const response = await entrypoint.fetch(fetchUrl, { signal: controller.signal });
		const results: TestRunResults = await response.json();
		return results;
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') {
			throw new Error(`Test timed out after ${TEST_TIMEOUT_MS / 1000}s`);
		}
		throw error;
	} finally {
		clearTimeout(timeout);
		abortSignal?.removeEventListener('abort', onParentAbort);
	}
}

async function hashString(content: string): Promise<string> {
	const data = new TextEncoder().encode(content);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = [...new Uint8Array(hashBuffer)];
	return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function formatTestOutput(
	results: Array<{ file: string; results: TestRunResults }>,
	bundleErrors: Array<{ file: string; error: string }>,
	totalPassed: number,
	totalFailed: number,
	totalCount: number,
): string {
	const lines: string[] = [];

	// Per-file results
	for (const { file, results: fileResults } of results) {
		if (fileResults.error) {
			lines.push(`FAIL ${file}`, `  Error: ${fileResults.error}`, '');
			continue;
		}

		const fileStatus = fileResults.failed === 0 ? 'PASS' : 'FAIL';
		lines.push(`${fileStatus} ${file}`);

		for (const suite of fileResults.suites) {
			for (const test of suite.tests) {
				const icon = test.status === 'passed' ? '  ✓' : '  ✗';
				const label = suite.name === '(top-level)' ? test.name : `${suite.name} > ${test.name}`;
				lines.push(`${icon} ${label}${test.duration > 100 ? ` (${test.duration}ms)` : ''}`);
				if (test.error) {
					lines.push(`    Error: ${test.error}`);
				}
			}
		}

		lines.push('');
	}

	// Bundle/load errors
	for (const { file, error } of bundleErrors) {
		lines.push(`FAIL ${file}`, `  Bundle error: ${error}`, '');
	}

	// Summary
	const parts: string[] = [];
	if (totalFailed > 0) parts.push(`${totalFailed} failed`);
	if (totalPassed > 0) parts.push(`${totalPassed} passed`);
	parts.push(`${totalCount} total`);

	lines.push(`Tests: ${parts.join(', ')}`);

	return lines.join('\n');
}
