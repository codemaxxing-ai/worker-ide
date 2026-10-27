import { ToolErrorCode, toolError } from '@shared/tool-errors';

import { buildSubAgentArtifactEntry } from '../memory/artifacts';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext, ToolResult } from '../types';

export const definition: ToolDefinition = {
	name: 'sub_agent',
	description:
		'Delegate a focused task to a sub-agent with its own isolated storage and fresh context window. Use this for deep exploration or self-contained subtasks.',
	input_schema: {
		type: 'object',
		properties: {
			prompt: {
				type: 'string',
				description: 'A clear, specific description of the task for the sub-agent to perform.',
			},
			context: {
				type: 'string',
				description: 'Optional additional context (relevant file paths, constraints, or goals).',
			},
		},
		required: ['prompt'],
	},
};

export async function execute(
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
	_queryChanges?: unknown[],
): Promise<ToolResult> {
	if (!context.agentReference) {
		return toolError(ToolErrorCode.NOT_ALLOWED, 'Sub-agents require an Agent context.');
	}

	const prompt = input.prompt?.trim();
	if (!prompt) {
		return toolError(ToolErrorCode.MISSING_INPUT, 'A non-empty prompt is required.');
	}
	const additionalContext = input.context?.trim();

	let fullPrompt = prompt;
	if (additionalContext) {
		fullPrompt += `\n\nAdditional context:\n${additionalContext}`;
	}

	sendEvent('status', { message: 'Delegating task to sub-agent...' });
	const { SubAgentWorker } = await import('../../../durable/sub-agent-worker');
	const result = await context.agentReference.runAgentTool(SubAgentWorker, {
		input: {
			prompt: fullPrompt,
			projectId: context.projectId,
			organizationId: context.organizationId,
			model: context.model,
			sessionId: context.sessionId,
			userId: context.userId,
			requestOriginContext: context.requestOriginContext,
			parentToolCallId: context.toolCallId,
			parentSubmissionId: context.submissionId,
		},
		runId: context.toolCallId ? `agent-tool:${context.toolCallId}` : undefined,
		parentToolCallId: context.toolCallId,
		display: { name: deriveShortTitle(prompt) },
	});
	if (result.status !== 'completed') {
		return toolError(ToolErrorCode.NOT_ALLOWED, result.error ?? `Sub-agent ${result.status}.`);
	}
	const output = result.summary?.trim() || '(Sub-agent completed without producing text output)';
	const artifactEntry = buildSubAgentArtifactEntry({
		sessionId: context.sessionId,
		prompt,
		additionalContext,
		resultText: output,
		iterations: 1,
	});
	if (context.indexArtifact) {
		await context.indexArtifact(artifactEntry);
	}

	const shortTitle = deriveShortTitle(prompt);
	return {
		title: shortTitle,
		metadata: {
			runId: result.runId,
			outputLength: output.length,
			artifactKey: context.indexArtifact ? artifactEntry.key : undefined,
			shortTitle,
		},
		output,
	};
}

function deriveShortTitle(prompt: string): string {
	const maxLength = 60;
	const cleaned = prompt.trim().replaceAll(/\s+/g, ' ');
	if (cleaned.length <= maxLength) return cleaned;
	const truncated = cleaned.slice(0, maxLength);
	const lastSpace = truncated.lastIndexOf(' ');
	return `${lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated}...`;
}
