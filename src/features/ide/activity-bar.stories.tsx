import { expect, userEvent, within } from 'storybook/test';

import { ActivityBar } from './activity-bar';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
	title: 'Core/ActivityBar',
	component: ActivityBar,
	parameters: {
		layout: 'fullscreen',
	},
} satisfies Meta<typeof ActivityBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	render: () => (
		<div className="flex h-screen bg-bg-primary">
			<ActivityBar />
			<div className="flex-1 p-4">
				<h1 className="text-xl font-bold">Main Content</h1>
				<p className="mt-2 text-text-secondary">The activity bar is visible on the left.</p>
			</div>
		</div>
	),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(await canvas.findByText('Main Content')).toBeInTheDocument();

		const buttons = canvas.getAllByRole('button');
		await expect(buttons.length).toBeGreaterThan(0);
		await userEvent.click(buttons[0]);
		await userEvent.click(buttons[1]);
	},
};
