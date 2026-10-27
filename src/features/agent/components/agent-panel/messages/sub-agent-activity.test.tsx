import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';

import { InlineSubAgentActivity } from './sub-agent-activity';

import type { SubAgentActivityRecord } from '@shared/agent-state';

it('shows child command progress and replaces it with the canonical child result', () => {
	const record: SubAgentActivityRecord = {
		debugLogId: undefined,
		streamingText: undefined,
		tools: [
			{
				toolCallId: 'child',
				toolName: 'exec',
				title: 'Command',
				metadata: {},
				commandOutput: {
					executions: [
						{ executionId: 'one', stdout: 'partial child output', stderr: '', stdoutBytes: 20, stderrBytes: 0, truncated: false },
					],
					truncated: false,
				},
			},
		],
	};
	const renderActivity = (activity: SubAgentActivityRecord) => (
		<InlineSubAgentActivity
			toolCallId="parent"
			metadata={undefined}
			rawResultContent={undefined}
			projectId={undefined}
			isExpanded
			subAgentActivities={{ parent: activity }}
		/>
	);
	const { rerender } = render(renderActivity(record));
	expect(screen.getByText('partial child output')).toBeInTheDocument();
	rerender(renderActivity({ ...record, tools: record.tools.map((entry) => ({ ...entry, result: 'final child output' })) }));
	expect(screen.queryByText('partial child output')).not.toBeInTheDocument();
	expect(screen.getByText('final child output')).toBeInTheDocument();
});
