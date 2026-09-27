import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';

function cleanBuildErrorMessage(message: string): string {
	return message
		.replaceAll(/\[plugin: [^\]]+\]\s*/g, '')
		.replaceAll(/\bERROR:\s*/g, '')
		.trim();
}

function resolveOriginalLocationFromStack(
	stack: string | undefined,
	bundledCode: string | undefined,
): { file: string; line?: number; column?: number } | undefined {
	if (!stack || !bundledCode) {
		return undefined;
	}

	const sourceMap = extractInlineSourceMap(bundledCode);
	if (!sourceMap) {
		return undefined;
	}

	const traceMap = new TraceMap(sourceMap);
	for (const stackLine of stack.split('\n')) {
		const generatedLocation = parseGeneratedWorkerLocation(stackLine);
		if (!generatedLocation) {
			continue;
		}

		const originalLocation = originalPositionFor(traceMap, {
			line: generatedLocation.line,
			column: generatedLocation.column - 1,
		});
		if (originalLocation.source && originalLocation.line) {
			return {
				file: originalLocation.source,
				line: originalLocation.line,
				column: originalLocation.column === null ? undefined : originalLocation.column + 1,
			};
		}
	}

	return undefined;
}

function parseGeneratedWorkerLocation(stackLine: string): { line: number; column: number } | undefined {
	const match = stackLine.match(/\b(?:worker|user-worker|bundle)\.js:(\d+):(\d+)\b/);
	if (!match) {
		return undefined;
	}
	return { line: Number(match[1]), column: Number(match[2]) };
}

function extractInlineSourceMap(code: string): string | undefined {
	const match = code.match(/sourceMappingURL=data:application\/json(?:;charset=utf-8)?;base64,([^\s]+)/);
	if (!match) {
		return undefined;
	}
	return atob(match[1]);
}

export { cleanBuildErrorMessage, resolveOriginalLocationFromStack };
