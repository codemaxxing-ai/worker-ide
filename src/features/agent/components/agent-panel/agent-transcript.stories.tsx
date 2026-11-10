import { expect, userEvent, within } from 'storybook/test';

import { initialChatState } from '@shared/agent-chat';

import { AgentTranscript } from './agent-transcript';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
	title: 'Features/Agent/Transcript',
	component: AgentTranscript,
	decorators: [
		(Story) => (
			<div className="w-full max-w-lg bg-bg-primary p-4 text-text-primary">
				<Story />
			</div>
		),
	],
	args: {
		projectId: 'story-project',
		messages: [
			{ id: 'request', role: 'user', metadata: { authorName: 'Alex' }, parts: [{ type: 'text', text: 'Add a compact navigation bar.' }] },
			{
				id: 'answer',
				role: 'assistant',
				metadata: { submissionId: 'turn' },
				parts: [
					{ type: 'reasoning', text: 'I will use the existing spacing and color tokens.' },
					{
						type: 'tool-exec',
						toolCallId: 'command',
						state: 'output-available',
						input: { command: 'bun run typecheck', backend: 'container' },
						output: { exitCode: 0, stdout: 'Typecheck passed', stderr: '' },
					},
					{ type: 'text', text: 'Added the navigation bar and checked its types.' },
				],
			},
		],
	},
} satisfies Meta<typeof AgentTranscript>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Completed: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByText('Reasoning'));
		await expect(canvas.getByText('I will use the existing spacing and color tokens.')).toBeVisible();
		await expect(canvas.getByText('Added the navigation bar and checked its types.')).toBeVisible();
	},
};

export const StreamingCommand: Story = {
	args: {
		messages: [
			{
				id: 'running',
				role: 'assistant',
				metadata: { submissionId: 'turn' },
				parts: [
					{ type: 'tool-exec', toolCallId: 'command', state: 'input-available', input: { command: 'bun run test', backend: 'container' } },
				],
			},
		],
		state: {
			...initialChatState(),
			status: 'running',
			activeSubmissionId: 'turn',
			toolMetadata: {
				command: {
					toolCallId: 'command',
					toolName: 'exec',
					title: 'bun run test',
					metadata: {},
					commandOutput: {
						truncated: false,
						executions: [
							{ executionId: 'execution', stdout: 'Running 12 tests…\n', stderr: '', stdoutBytes: 20, stderrBytes: 0, truncated: false },
						],
					},
				},
			},
		},
	},
};

export const Mobile: Story = {
	decorators: [
		(Story) => (
			<div className="w-72">
				<Story />
			</div>
		),
	],
};
