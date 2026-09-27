export interface DiscoveredTest {
	name: string;
	suiteName: string;
	line?: number;
}
export interface DiscoveredTestFile {
	file: string;
	tests: DiscoveredTest[];
}
export interface TestResultEntry {
	name: string;
	status: 'passed' | 'failed';
	error?: string;
	duration: number;
}
export interface TestSuiteResult {
	name: string;
	tests: TestResultEntry[];
	passed: number;
	failed: number;
}
export interface TestFileResult {
	file: string;
	results: {
		suites: TestSuiteResult[];
		passed: number;
		failed: number;
		total: number;
		duration: number;
		error?: string;
	};
}
export interface TestRunResponse {
	title: string;
	output: string;
	metadata: {
		passed: number;
		failed: number;
		total: number;
		files: number;
		bundleErrors: number;
	};
	fileResults: TestFileResult[];
	bundleErrors: Array<{ file: string; error: string }>;
	timestamp: number;
}

/**
 * Merge a single-test run result into an existing full result set.
 * Updates only the specific test(s) that were re-run, keeping all other tests intact.
 * Used client-side when a single test is re-run (from the mutation onSuccess handler
 * and the WebSocket broadcast handler).
 */
export function mergeTestRunResults(existing: TestRunResponse, incoming: TestRunResponse): TestRunResponse {
	const updatedFileResults: TestFileResult[] = existing.fileResults.map((existingFile) => {
		const incomingFile = incoming.fileResults.find((f) => f.file === existingFile.file);
		if (!incomingFile) return existingFile;

		// Group all tests (existing and incoming) by suite so we don't lose any
		const mergedSuitesMap = new Map<string, Map<string, TestSuiteResult['tests'][number]>>();

		// 1. Add all existing tests into the map
		for (const suite of existingFile.results.suites) {
			const suiteMap = new Map<string, TestSuiteResult['tests'][number]>();
			for (const test of suite.tests) {
				suiteMap.set(test.name, test);
			}
			mergedSuitesMap.set(suite.name, suiteMap);
		}

		// 2. Overlay incoming tests (adding new ones, replacing existing ones)
		for (const suite of incomingFile.results.suites) {
			let suiteMap = mergedSuitesMap.get(suite.name);
			if (!suiteMap) {
				suiteMap = new Map<string, TestSuiteResult['tests'][number]>();
				mergedSuitesMap.set(suite.name, suiteMap);
			}
			for (const test of suite.tests) {
				suiteMap.set(test.name, test);
			}
		}

		// 3. Rebuild the suites array and aggregate counts
		const mergedSuites: TestSuiteResult[] = [];
		let totalPassed = 0;
		let totalFailed = 0;
		let totalCount = 0;

		for (const [suiteName, testsMap] of mergedSuitesMap.entries()) {
			let suitePassed = 0;
			let suiteFailed = 0;
			const mergedTests = [...testsMap.values()];

			for (const test of mergedTests) {
				if (test.status === 'passed') {
					suitePassed++;
				} else {
					suiteFailed++;
				}
			}

			mergedSuites.push({
				name: suiteName,
				tests: mergedTests,
				passed: suitePassed,
				failed: suiteFailed,
			});

			totalPassed += suitePassed;
			totalFailed += suiteFailed;
			totalCount += mergedTests.length;
		}

		return {
			file: existingFile.file,
			results: {
				...existingFile.results,
				suites: mergedSuites,
				passed: totalPassed,
				failed: totalFailed,
				total: totalCount,
			},
		};
	});

	// Recompute top-level metadata
	let passed = 0;
	let failed = 0;
	let total = 0;
	for (const fileResult of updatedFileResults) {
		passed += fileResult.results.passed;
		failed += fileResult.results.failed;
		total += fileResult.results.total;
	}

	return {
		...existing,
		fileResults: updatedFileResults,
		metadata: {
			...existing.metadata,
			passed,
			failed,
			total,
		},
		title: failed === 0 ? `${passed} passed` : `${failed} failed, ${passed} passed`,
		timestamp: incoming.timestamp,
	};
}
