import type { SendEventFunction, ToolDefinition, ToolExecutorContext, ToolResult } from '../types';

const DESCRIPTION = `Ask the user a question that ONLY they can answer. Do NOT use this tool for questions you could resolve by reading files, searching the codebase, or using any other tool. Exhaust all other research options first.

Usage:
- ONLY use this when the answer requires human judgment, preference, or information not available in the project (e.g. choosing between design alternatives, confirming destructive actions, or requesting credentials/config values).
- Do NOT ask the user questions that can be answered by reading code, grepping, globbing, fetching docs, or any other tool.
- Provide suggested options as a comma-separated string to help guide the user.
- The user can pick from the options or provide a custom answer.
- A successful call ends this turn. The answer will arrive in the user's next message; continue once it arrives.`;

export const definition: ToolDefinition = {
	name: 'user_question',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {
			question: { type: 'string', description: 'The question to ask the user' },
			options: { type: 'string', description: 'Comma-separated list of suggested options for the user' },
		},
		required: ['question'],
	},
};

export async function execute(
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	_context: ToolExecutorContext,
): Promise<ToolResult> {
	const questionText = input.question;
	const questionOptions = input.options;

	sendEvent('status', { message: 'Asking user...' });

	// Emit the user_question CUSTOM event so the frontend can show the interactive
	// question prompt (UserQuestionPrompt component). Without this, the frontend
	// never knows to display the question UI with clickable option buttons.
	sendEvent('user_question', { question: questionText, options: questionOptions });

	let resultText = `Question for the user: ${questionText}`;
	if (questionOptions) {
		resultText += `\nSuggested options: ${questionOptions}`;
	}
	resultText += '\n\nThe user will respond in their next message.';

	return {
		title: questionText.length > 60 ? questionText.slice(0, 60) + '...' : questionText,
		metadata: {
			question: questionText,
			options: questionOptions
				? questionOptions
						.split(',')
						.map((o) => o.trim())
						.filter(Boolean)
				: [],
		},
		output: resultText,
	};
}
