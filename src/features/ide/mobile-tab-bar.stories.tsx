import { expect, userEvent, within } from 'storybook/test';

import { MobileTabBar } from './mobile-tab-bar';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
	title: 'Core/MobileTabBar',
	component: MobileTabBar,
	parameters: {
		layout: 'fullscreen',
	},
} satisfies Meta<typeof MobileTabBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	render: () => (
		<div className="flex h-screen flex-col bg-bg-primary">
			<div className="flex flex-1 items-center justify-center p-4">
				<p className="text-center text-text-secondary">
					This is a mobile layout demo. <br /> Check the bottom tab bar.
				</p>
			</div>
			<div className="fixed inset-x-0 bottom-0">
				<MobileTabBar />
			</div>
		</div>
	),
	parameters: {
		viewport: {
			defaultViewport: 'mobile1',
		},
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const editorTab = await canvas.findByRole('button', { name: /Editor/i });
		const previewTab = await canvas.findByRole('button', { name: /Preview/i });
		const gitTab = await canvas.findByRole('button', { name: /Git/i });
		const agentTab = await canvas.findByRole('button', { name: /Agent/i });

		await expect(editorTab).toBeInTheDocument();
		await expect(previewTab).toBeInTheDocument();

		await userEvent.click(previewTab);
		await userEvent.click(gitTab);
		await userEvent.click(agentTab);
		await userEvent.click(editorTab);
	},
};
