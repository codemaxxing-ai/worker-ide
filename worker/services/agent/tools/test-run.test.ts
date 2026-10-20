import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryFs, createMockContext, createMockSendEvent } from './test-helpers';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
	const bundleWithCdn = vi.fn();
	function createLoaderMock(responseBody: unknown, status = 200) {
		return {
			get: vi.fn().mockReturnValue({
				getEntrypoint: () => ({
					fetch: vi.fn().mockResolvedValue(Response.json(responseBody, { status })),
				}),
			}),
		};
	}

	const loader = createLoaderMock({
		suites: [],
		passed: 0,
		failed: 0,
		total: 0,
		duration: 0,
	});

	return { bundleWithCdn, loader, createLoaderMock };
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const memoryFs = createMemoryFs();

vi.mock('@worker/lib/project-fs', () => memoryFs.asMock());

vi.mock('cloudflare:workers', () => ({
	env: {
		LOADER: mocks.loader,
	},
}));

vi.mock('../../bundler-client', () => ({
	bundleWithCdn: mocks.bundleWithCdn,
}));

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

const { execute } = await import('./test-run');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = '/project';

function context() {
	return createMockContext({ projectRoot: PROJECT_ROOT });
}

function seedTestProject() {
	memoryFs.seedFile(`${PROJECT_ROOT}/src/math.ts`, 'export function add(a, b) { return a + b; }');
	memoryFs.seedFile(`${PROJECT_ROOT}/test/math.test.ts`, 'import { add } from "../src/math"; it("adds", () => expect(add(1,2)).toBe(3));');
}

function passingResults(testName = 'adds', suiteName = '(top-level)') {
	return {
		suites: [
			{
				name: suiteName,
				tests: [{ name: testName, status: 'passed', duration: 1 }],
				passed: 1,
				failed: 0,
			},
		],
		passed: 1,
		failed: 0,
		total: 1,
		duration: 5,
	};
}

function failingResults(testName = 'adds', errorMessage = 'Expected 3 to be 4') {
	return {
		suites: [
			{
				name: '(top-level)',
				tests: [{ name: testName, status: 'failed', error: errorMessage, duration: 1 }],
				passed: 0,
				failed: 1,
			},
		],
		passed: 0,
		failed: 1,
		total: 1,
		duration: 5,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('test_run', () => {
	beforeEach(() => {
		memoryFs.reset();
		mocks.bundleWithCdn.mockReset();
		mocks.loader.get.mockReset();

		// Default: bundler returns dummy code
		mocks.bundleWithCdn.mockResolvedValue({ code: '// bundled test code', warnings: [] });

		// Default: loader returns passing test results
		const defaultResults = passingResults();
		mocks.loader.get.mockReturnValue({
			getEntrypoint: () => ({
				fetch: vi.fn().mockResolvedValue(Response.json(defaultResults)),
			}),
		});
	});

	// ── File discovery ───────────────────────────────────────────────────

	describe('file discovery', () => {
		it('discovers test files using the default glob pattern', async () => {
			seedTestProject();

			const result = await execute({}, createMockSendEvent(), context());

			expect(result.output).toContain('math.test.ts');
			expect(mocks.bundleWithCdn).toHaveBeenCalledOnce();
		});

		it('discovers test files matching a custom glob pattern', async () => {
			memoryFs.seedFile(`${PROJECT_ROOT}/src/math.ts`, 'export const add = (a, b) => a + b;');
			memoryFs.seedFile(`${PROJECT_ROOT}/src/math.spec.ts`, 'it("works", () => {});');
			memoryFs.seedFile(`${PROJECT_ROOT}/test/other.test.ts`, 'it("other", () => {});');

			const result = await execute({ pattern: 'src/**/*.spec.ts' }, createMockSendEvent(), context());

			expect(result.output).toContain('math.spec.ts');
			expect(result.output).not.toContain('other.test.ts');
		});

		it('discovers a specific test file by path', async () => {
			seedTestProject();

			const result = await execute({ pattern: 'test/math.test.ts' }, createMockSendEvent(), context());

			expect(result.output).toContain('math.test.ts');
			expect(mocks.bundleWithCdn).toHaveBeenCalledOnce();
		});

		it('throws FILE_NOT_FOUND when specific file does not exist', async () => {
			memoryFs.seedFile(`${PROJECT_ROOT}/src/math.ts`, 'content');

			await expect(execute({ pattern: 'test/nonexistent.test.ts' }, createMockSendEvent(), context())).rejects.toThrow('FILE_NOT_FOUND');
		});

		it('throws FILE_NOT_FOUND when no files match glob', async () => {
			memoryFs.seedFile(`${PROJECT_ROOT}/src/math.ts`, 'content');

			await expect(execute({ pattern: '**/*.test.py' }, createMockSendEvent(), context())).rejects.toThrow('FILE_NOT_FOUND');
		});
	});

	// ── Passing tests ────────────────────────────────────────────────────

	describe('passing tests', () => {
		it('returns structured output for a passing test', async () => {
			seedTestProject();

			const result = await execute({}, createMockSendEvent(), context());

			expect(result.title).toBe('1 passed');
			expect(result.metadata).toEqual(
				expect.objectContaining({
					passed: 1,
					failed: 0,
					total: 1,
					files: 1,
				}),
			);
			expect(result.output).toContain('PASS');
		});

		it('reports suite name in output for named suites', async () => {
			seedTestProject();

			mocks.loader.get.mockReturnValue({
				getEntrypoint: () => ({
					fetch: vi.fn().mockResolvedValue(Response.json(passingResults('adds numbers', 'math'))),
				}),
			});

			const result = await execute({}, createMockSendEvent(), context());

			expect(result.output).toContain('math > adds numbers');
		});
	});

	// ── Failing tests ────────────────────────────────────────────────────

	describe('failing tests', () => {
		it('returns structured output for a failing test', async () => {
			seedTestProject();

			mocks.loader.get.mockReturnValue({
				getEntrypoint: () => ({
					fetch: vi.fn().mockResolvedValue(Response.json(failingResults())),
				}),
			});

			const result = await execute({}, createMockSendEvent(), context());

			expect(result.title).toBe('1 failed, 0 passed');
			expect(result.metadata).toEqual(
				expect.objectContaining({
					passed: 0,
					failed: 1,
					total: 1,
				}),
			);
			expect(result.output).toContain('FAIL');
			expect(result.output).toContain('Expected 3 to be 4');
		});
	});

	// ── Multiple test files ──────────────────────────────────────────────

	describe('multiple test files', () => {
		it('runs multiple test files independently', async () => {
			memoryFs.seedFile(`${PROJECT_ROOT}/src/math.ts`, 'export const add = (a, b) => a + b;');
			memoryFs.seedFile(`${PROJECT_ROOT}/test/math.test.ts`, 'it("adds", () => {});');
			memoryFs.seedFile(`${PROJECT_ROOT}/test/string.test.ts`, 'it("trims", () => {});');

			const result = await execute({}, createMockSendEvent(), context());

			expect(mocks.bundleWithCdn).toHaveBeenCalledTimes(2);
			expect(result.metadata).toEqual(
				expect.objectContaining({
					files: 2,
					total: 2,
				}),
			);
		});
	});

	// ── Bundler integration ──────────────────────────────────────────────

	describe('bundler integration', () => {
		it('passes project files and test harness to the bundler', async () => {
			seedTestProject();

			await execute({}, createMockSendEvent(), context());

			expect(mocks.bundleWithCdn).toHaveBeenCalledOnce();
			const callArguments = mocks.bundleWithCdn.mock.calls[0][0];

			// Should include project source files
			expect(callArguments.files).toHaveProperty('src/math.ts');
			// Should include harness module that sets up globals
			expect(callArguments.files).toHaveProperty('__test_harness__.js');
			// The harness module should contain harness code
			expect(callArguments.files['__test_harness__.js']).toContain('globalThis.describe');
			expect(callArguments.files['__test_harness__.js']).toContain('globalThis.expect');
			// Should include the entry point that imports harness then test file
			expect(callArguments.files).toHaveProperty('__test_entry__.js');
			expect(callArguments.files['__test_entry__.js']).toContain('__test_harness__');
			expect(callArguments.entryPoint).toBe('__test_entry__.js');
		});

		it('passes tsconfig when available', async () => {
			seedTestProject();
			memoryFs.seedFile(`${PROJECT_ROOT}/tsconfig.json`, '{"compilerOptions":{"strict":true}}');

			await execute({}, createMockSendEvent(), context());

			const callArguments = mocks.bundleWithCdn.mock.calls[0][0];
			expect(callArguments.tsconfigRaw).toBe('{"compilerOptions":{"strict":true}}');
		});

		it('passes known dependencies from package.json', async () => {
			seedTestProject();
			memoryFs.seedFile(
				`${PROJECT_ROOT}/package.json`,
				JSON.stringify({ name: 'test', type: 'module', dependencies: { lodash: '^4.0.0' } }),
			);

			await execute({}, createMockSendEvent(), context());

			const callArguments = mocks.bundleWithCdn.mock.calls[0][0];
			expect(callArguments.knownDependencies).toBeInstanceOf(Map);
			expect(callArguments.knownDependencies.get('lodash')).toBe('^4.0.0');
		});

		it('reports bundle errors gracefully', async () => {
			seedTestProject();
			mocks.bundleWithCdn.mockRejectedValue(new Error('esbuild compilation failed'));

			const result = await execute({}, createMockSendEvent(), context());

			expect(result.output).toContain('Bundle error');
			expect(result.output).toContain('esbuild compilation failed');
			expect(result.metadata).toEqual(
				expect.objectContaining({
					failed: 1,
					bundleErrors: 1,
				}),
			);
		});
	});

	// ── WorkerLoader execution ───────────────────────────────────────────

	describe('worker loader execution', () => {
		it('passes bundled code to WorkerLoader', async () => {
			seedTestProject();
			mocks.bundleWithCdn.mockResolvedValue({ code: 'const x = 1;', warnings: [] });

			await execute({}, createMockSendEvent(), context());

			expect(mocks.loader.get).toHaveBeenCalledOnce();
			const callback = mocks.loader.get.mock.calls[0][1];
			// The callback should produce worker config with the bundled code
			const config = await callback();
			expect(config.modules).toEqual({ 'test-worker.js': 'const x = 1;' });
			expect(config.mainModule).toBe('test-worker.js');
			expect(config.globalOutbound).toBeNull();
		});

		it('handles runtime errors from the worker', async () => {
			seedTestProject();

			const errorResults = {
				suites: [],
				passed: 0,
				failed: 0,
				total: 0,
				duration: 0,
				error: 'ReferenceError: foo is not defined',
			};
			mocks.loader.get.mockReturnValue({
				getEntrypoint: () => ({
					fetch: vi.fn().mockResolvedValue(Response.json(errorResults, { status: 500 })),
				}),
			});

			const result = await execute({}, createMockSendEvent(), context());

			expect(result.output).toContain('ReferenceError: foo is not defined');
		});
	});

	// ── Status events ────────────────────────────────────────────────────

	describe('status events', () => {
		it('sends status events during execution', async () => {
			seedTestProject();

			const sendEvent = createMockSendEvent();
			await execute({}, sendEvent, context());

			const statusEvents = sendEvent.calls.filter(([type]) => type === 'status');
			expect(statusEvents.length).toBeGreaterThanOrEqual(2);
			// First status should mention finding files
			expect(statusEvents[0][1].message).toContain('Finding test files');
			// Later status should mention running
			expect(statusEvents.at(-1)?.[1].message).toContain('Running');
		});
	});

	// ── Output formatting ────────────────────────────────────────────────

	describe('output formatting', () => {
		it('includes summary line with counts', async () => {
			seedTestProject();

			const result = await execute({}, createMockSendEvent(), context());

			expect(result.output).toContain('Tests:');
			expect(result.output).toContain('1 passed');
			expect(result.output).toContain('1 total');
		});

		it('marks slow tests with duration', async () => {
			seedTestProject();

			mocks.loader.get.mockReturnValue({
				getEntrypoint: () => ({
					fetch: vi.fn().mockResolvedValue(
						Response.json({
							suites: [
								{
									name: '(top-level)',
									tests: [{ name: 'slow test', status: 'passed', duration: 250 }],
									passed: 1,
									failed: 0,
								},
							],
							passed: 1,
							failed: 0,
							total: 1,
							duration: 250,
						}),
					),
				}),
			});

			const result = await execute({}, createMockSendEvent(), context());

			expect(result.output).toContain('250ms');
		});

		it('omits duration for fast tests', async () => {
			seedTestProject();

			const result = await execute({}, createMockSendEvent(), context());

			// Default passing result has duration: 1, should not show (< 100ms)
			expect(result.output).not.toContain('1ms');
		});
	});

	// ── testName filtering ──────────────────────────────────────────────

	describe('testName filtering', () => {
		it('passes testName as query parameter to the worker', async () => {
			seedTestProject();

			let capturedUrl = '';
			mocks.loader.get.mockReturnValue({
				getEntrypoint: () => ({
					fetch: vi.fn().mockImplementation((url: string) => {
						capturedUrl = url;
						return Promise.resolve(Response.json(passingResults()));
					}),
				}),
			});

			await execute({ testName: 'math > adds' }, createMockSendEvent(), context());

			expect(capturedUrl).toContain('testName=');
			expect(capturedUrl).toContain(encodeURIComponent('math > adds'));
		});

		it('returns only the filtered test in results', async () => {
			seedTestProject();

			// Simulate harness returning only the matched test
			const filteredResults = {
				suites: [
					{
						name: 'math',
						tests: [{ name: 'adds', status: 'passed', duration: 1 }],
						passed: 1,
						failed: 0,
					},
				],
				passed: 1,
				failed: 0,
				total: 1,
				duration: 2,
			};
			mocks.loader.get.mockReturnValue({
				getEntrypoint: () => ({
					fetch: vi.fn().mockResolvedValue(Response.json(filteredResults)),
				}),
			});

			const result = await execute({ testName: 'math > adds' }, createMockSendEvent(), context());

			expect(result.metadata).toEqual(
				expect.objectContaining({
					passed: 1,
					failed: 0,
					total: 1,
				}),
			);
		});

		it('returns empty suites when testName does not match any test', async () => {
			seedTestProject();

			// Harness skips all tests → empty suites
			const emptyResults = {
				suites: [],
				passed: 0,
				failed: 0,
				total: 0,
				duration: 1,
			};
			mocks.loader.get.mockReturnValue({
				getEntrypoint: () => ({
					fetch: vi.fn().mockResolvedValue(Response.json(emptyResults)),
				}),
			});

			const result = await execute({ testName: 'nonexistent > test' }, createMockSendEvent(), context());

			expect(result.metadata).toEqual(
				expect.objectContaining({
					passed: 0,
					failed: 0,
					total: 0,
				}),
			);
		});

		it('combines testName with pattern to target a specific file', async () => {
			memoryFs.seedFile(`${PROJECT_ROOT}/src/math.ts`, 'export const add = (a, b) => a + b;');
			memoryFs.seedFile(`${PROJECT_ROOT}/test/math.test.ts`, 'it("adds", () => {});');
			memoryFs.seedFile(`${PROJECT_ROOT}/test/string.test.ts`, 'it("trims", () => {});');

			await execute({ pattern: 'test/math.test.ts', testName: 'adds' }, createMockSendEvent(), context());

			// Should only bundle one file
			expect(mocks.bundleWithCdn).toHaveBeenCalledOnce();
		});
	});
});
