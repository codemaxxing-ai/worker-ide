import { ToolExecutionError } from '@shared/tool-errors';

import { buildPlanArtifactEntry } from '../memory/artifacts';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext, ToolResult } from '../types';

const DESCRIPTION = `Update the current implementation plan. Use this to mark steps as complete, add new steps, or revise the plan as you make progress. The plan helps the user understand your approach and track progress.

Usage:
- Provide the full updated plan content, not just the changes.
- Use markdown format for structure (headings, lists, checkboxes).
- Update the plan as you progress through implementation.
- Keep the plan concise and actionable. Avoid unnecessary detail.`;

export const definition: ToolDefinition = {
	name: 'plan_update',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {
			content: { type: 'string', description: 'The full updated plan content in markdown format' },
		},
		required: ['content'],
	},
};

export async function execute(
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
): Promise<ToolResult> {
	const { sessionId } = context;
	const content = input.content;

	sendEvent('status', { message: 'Updating plan...' });

	try {
		const { path, previousContent } = await context.fsStub.writeAgentDocument('plan', sessionId || 'default', content);
		const planFilePath = path.replace(/^\//, '');

		if (context.indexArtifact) {
			await context.indexArtifact(buildPlanArtifactEntry(sessionId, content));
		}
		sendEvent('plan_updated', { content });

		const lineCount = content.split('\n').length;
		const completedCount = (content.match(/- \[x\]/gi) || []).length;
		const pendingCount = (content.match(/- \[ \]/g) || []).length;
		const totalTasks = completedCount + pendingCount;

		let result = `Plan updated (${lineCount} lines).`;
		if (totalTasks > 0) {
			result += ` Progress: ${completedCount}/${totalTasks} tasks completed.`;
		}
		if (previousContent === content) {
			result += ' (no changes from previous plan)';
		}

		return { title: 'plan', metadata: { completedTasks: completedCount, totalTasks, planFilePath }, output: result };
	} catch (error) {
		throw new ToolExecutionError('MISSING_INPUT', `Failed to update plan: ${String(error)}`);
	}
}
