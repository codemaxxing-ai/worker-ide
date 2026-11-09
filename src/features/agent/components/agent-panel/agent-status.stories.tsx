import { expect, waitFor, within } from 'storybook/test';

import { cn } from '@/lib/utils';

import { AgentStatus } from './agent-status';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
	title: 'Features/Agent/AgentStatus',
	component: AgentStatus,
	args: { message: 'Updating dependency: @types/three...' },
	decorators: [
		(Story, context) => (
			// eslint-disable-next-line better-tailwindcss/no-unknown-classes -- Theme marker for the custom dark variant.
			<div className={cn('w-64 bg-bg-primary p-3', context.parameters.theme === 'dark' && 'dark')}>
				<Story />
			</div>
		),
	],
	play: async ({ canvasElement }) => {
		const status = within(canvasElement).getByRole('status');
		const text = within(status).getByText(/Updating dependency:/);
		await expect(getComputedStyle(text).animationName).toBe('shimmer-text');
		await expect(getComputedStyle(text).animationIterationCount).toBe('infinite');
		await expect(getComputedStyle(text).backgroundSize).toBe('200% 100%');
		await expect(getComputedStyle(text).backgroundRepeat).toBe('repeat');
		const initialPosition = getComputedStyle(text).backgroundPosition;
		await waitFor(async () => {
			await expect(getComputedStyle(text).backgroundPosition).not.toBe(initialPosition);
		});
		await expect(text.getBoundingClientRect().width).toBeLessThanOrEqual(status.getBoundingClientRect().width);
	},
} satisfies Meta<typeof AgentStatus>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Dark: Story = {
	parameters: { theme: 'dark' },
};

export const LongDependency: Story = {
	args: { message: 'Updating dependency: @example/a-package-with-a-very-long-name...' },
};
