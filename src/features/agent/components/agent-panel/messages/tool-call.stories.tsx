import { expect, within } from 'storybook/test';

import { InlineToolCall } from './tool-call';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
	title: 'Agent/Computer tools',
	component: InlineToolCall,
	args: { isExpanded: true, onToggleExpand: () => {} },
	tags: ['autodocs'],
} satisfies Meta<typeof InlineToolCall>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ContainerCommand: Story = {
	args: {
		toolCall: { type: 'tool-call', toolCallId: 'native', toolName: 'exec', arguments: { command: 'bun test', backend: 'container' } },
		toolResult: {
			type: 'tool-result',
			toolCallId: 'native',
			toolName: 'exec',
			result: JSON.stringify({ backend: 'container', exitCode: 0, stdout: '3 tests passed', stderr: '' }),
		},
	},
	play: async ({ canvasElement }) => {
		await expect(within(canvasElement).getByText('container · Exit 0')).toBeVisible();
	},
};
export const CancelledCommand: Story = {
	args: {
		toolCall: { type: 'tool-call', toolCallId: 'cancelled', toolName: 'exec', arguments: { command: 'bun test', backend: 'container' } },
		toolResult: {
			type: 'tool-result',
			toolCallId: 'cancelled',
			toolName: 'exec',
			result: JSON.stringify({ backend: 'container', exitCode: 137, stdout: 'Interrupted', stderr: '' }),
		},
	},
	play: async ({ canvasElement }) => {
		await expect(within(canvasElement).getByText('container · Cancelled')).toBeVisible();
	},
};

export const LiveCommandOutput: Story = {
	args: {
		toolCall: { type: 'tool-call', toolCallId: 'live', toolName: 'exec', arguments: { command: 'bun test' } },
		isStreaming: true,
		toolMetadata: new Map([
			[
				'live',
				{
					toolCallId: 'live',
					toolName: 'exec',
					title: 'exec',
					metadata: {},
					commandOutput: {
						executions: [
							{ executionId: 'one', stdout: 'Running tests…', stderr: 'A warning', stdoutBytes: 16, stderrBytes: 9, truncated: true },
						],
						truncated: true,
					},
				},
			],
		]),
	},
	play: async ({ canvasElement }) => {
		await expect(within(canvasElement).getByText('Running tests…')).toBeVisible();
		await expect(within(canvasElement).getByText('A warning')).toBeVisible();
		await expect(within(canvasElement).getByText('Output truncated')).toBeVisible();
	},
};
