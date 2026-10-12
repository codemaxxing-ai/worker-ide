import { describe, expect, it } from 'vitest';

import { AI_MODELS, CODE_MODE_SYSTEM_PROMPT, DEFAULT_AI_MODEL } from '@shared/constants';

import { buildSessionTurnInstructions, getTerminalSubmissionResult, parseActiveTurnConfiguration } from './session-turn-agent';

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
	it('includes mode-specific tool instructions and project guidelines', async () => {
		const instructions = await buildSessionTurnInstructions('code', 'Use project conventions.');

		expect(instructions).toContain(CODE_MODE_SYSTEM_PROMPT);
		expect(instructions).toContain('Computer tools');
		expect(instructions).toContain('backend "container"');
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
