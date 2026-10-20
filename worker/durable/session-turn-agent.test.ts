import { generateText, stepCountIs } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';

import { AI_MODELS, CODE_MODE_SYSTEM_PROMPT, DEFAULT_AI_MODEL } from '@shared/constants';

import {
	buildSessionTurnInstructions,
	getTerminalSubmissionResult,
	parseActiveTurnConfiguration,
	shouldWaitForUser,
} from './session-turn-agent';
import { createServerTools } from '../services/agent/tools';
import { createMockContext, createMockSendEvent } from '../services/agent/tools/test-helpers';

import type { ThinkSubmissionInspection } from '@cloudflare/think';

function submission(status: ThinkSubmissionInspection['status'], error?: string): ThinkSubmissionInspection {
	return {
		submissionId: 'submission-1',
		status,
		error,
		createdAt: 1,
	};
}

describe('session turn lifecycle', () => {
	it.each([false, true])('waits after a successful user question (invalid first call: %s)', async (invalidFirstCall) => {
		const sendEvent = createMockSendEvent();
		const tools = await createServerTools(sendEvent, createMockContext(), [], 'code');
		let modelCalls = 0;
		const model = new MockLanguageModelV3({
			doGenerate: async () => {
				modelCalls++;
				return {
					content: [
						{
							type: 'tool-call',
							toolCallId: `question-${modelCalls}`,
							toolName: 'user_question',
							input: JSON.stringify(invalidFirstCall && modelCalls === 1 ? {} : { question: 'Which color?', options: 'Red, Blue' }),
						},
					],
					finishReason: { unified: 'tool-calls', raw: undefined },
					usage: {
						inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
						outputTokens: { total: 1, text: 1, reasoning: 0 },
					},
					warnings: [],
				};
			},
		});

		const result = await generateText({ model, tools, prompt: 'Ask me to choose a color.', stopWhen: [stepCountIs(5), shouldWaitForUser] });

		expect(modelCalls).toBe(invalidFirstCall ? 2 : 1);
		expect(result.toolResults[0]?.toolName).toBe('user_question');
		expect(sendEvent.calls.filter(([type]) => type === 'user_question')).toEqual([
			['user_question', { question: 'Which color?', options: 'Red, Blue' }],
		]);
	});

	it('includes mode-specific tool instructions and project guidelines', async () => {
		const instructions = await buildSessionTurnInstructions('code', 'Use project conventions.');

		expect(instructions).toContain(CODE_MODE_SYSTEM_PROMPT);
		expect(instructions).toContain('Computer tools');
		expect(instructions).toContain('backend "auto"');
		expect(instructions).toContain('Full Worker projects resolve registered packages without a container');
		expect(instructions).toContain('single `codemode` snippet');
		expect(instructions).toContain('state.readdir');
		expect(instructions).toContain('## Project Guidelines (from AGENTS.md)\nUse project conventions.');
	});

	it('activates the submitted turn configuration from durable submission metadata', () => {
		const model = AI_MODELS[0].id;

		expect(
			parseActiveTurnConfiguration(
				{
					mode: 'plan',
					model,
					initiatorUserId: 'user-1',
					requestOriginContext: { appOrigin: 'https://example.com', contentOrigin: 'https://content.example.net' },
				},
				'submission-1',
			),
		).toEqual({
			submissionId: 'submission-1',
			mode: 'plan',
			model,
			initiatorUserId: 'user-1',
			requestOriginContext: { appOrigin: 'https://example.com', contentOrigin: 'https://content.example.net' },
		});
	});

	it('rejects missing or invalid durable submission metadata', () => {
		expect(parseActiveTurnConfiguration(undefined, 'submission-1')).toBeUndefined();
		expect(parseActiveTurnConfiguration({ mode: 'invalid', model: DEFAULT_AI_MODEL }, 'submission-1')).toBeUndefined();
		expect(parseActiveTurnConfiguration({ mode: 'code', model: 'invalid' }, 'submission-1')).toBeUndefined();
	});

	it('maps every terminal Think submission state to a parent session result', () => {
		expect(getTerminalSubmissionResult(submission('completed'))).toEqual({ status: 'completed' });
		expect(getTerminalSubmissionResult(submission('aborted', 'Cancelled by user'))).toEqual({
			status: 'aborted',
			error: 'Cancelled by user',
		});
		expect(getTerminalSubmissionResult(submission('error', 'Preparation failed'))).toEqual({
			status: 'error',
			error: 'Preparation failed',
		});
		expect(getTerminalSubmissionResult(submission('skipped'))).toEqual({
			status: 'error',
			error: 'The agent turn was skipped before it could run.',
		});
	});
});
