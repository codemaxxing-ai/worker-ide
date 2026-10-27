import { InlineCodeSection } from './tool-views';

import type { ToolCommandOutput } from '@shared/command-output';

export function CommandOutput({ output }: { output?: ToolCommandOutput }) {
	if (!output) return;
	return (
		<div className="flex flex-col gap-1.5">
			{output.executions.map((execution, index) => (
				<div key={execution.executionId} className="flex flex-col gap-1.5">
					{execution.stdout && (
						<InlineCodeSection label={output.executions.length > 1 ? `stdout (${index + 1})` : 'stdout'} content={execution.stdout} />
					)}
					{execution.stderr && (
						<InlineCodeSection label={output.executions.length > 1 ? `stderr (${index + 1})` : 'stderr'} content={execution.stderr} />
					)}
				</div>
			))}
			{output.truncated && <p className="text-2xs text-text-secondary">Output truncated</p>}
		</div>
	);
}
