import { MemoryRouter } from 'react-router';
import { expect, fn, userEvent, within } from 'storybook/test';

import { IDEHeader } from './ide-header';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
	title: 'IDE/IDEHeader',
	component: IDEHeader,
	decorators: [
		(Story) => (
			<MemoryRouter>
				<Story />
			</MemoryRouter>
		),
	],
	parameters: {
		layout: 'fullscreen',
	},
	tags: ['autodocs'],
	args: {
		projectNameState: {
			projectName: 'Test Project',
			isEditingName: false,
			handleStartRename: fn(),
			handleSaveRename: fn(),
			handleCancelRename: fn(),
		},
		isMobile: false,
		agentPanelVisible: false,
		toggleAgentPanel: fn(),
		isAgentProcessing: false,
		mobileMenuOpen: false,
		setMobileMenuOpen: fn(),
		onDownload: fn(),
		onDeploy: fn(),
		onSettings: fn(),
	},
} satisfies Meta<typeof IDEHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DesktopView: Story = {
	play: async ({ canvasElement, step, args }) => {
		const canvas = within(canvasElement);

		await step('Verify project name is displayed', async () => {
			const header = await canvas.findByText('Test Project');
			await expect(header).toBeInTheDocument();
		});

		await step('Verify desktop action buttons exist', async () => {
			await expect(await canvas.findByLabelText('Toggle Agent panel')).toBeInTheDocument();
			await expect(await canvas.findByLabelText('Download project')).toBeInTheDocument();
		});

		await step('Interact with Agent Toggle', async () => {
			const agentToggle = await canvas.findByLabelText('Toggle Agent panel');
			await userEvent.click(agentToggle);
			await expect(args.toggleAgentPanel).toHaveBeenCalled();
		});
	},
};

export const MobileView: Story = {
	args: {
		isMobile: true,
		agentPanelVisible: false,
	},
	play: async ({ canvasElement, step }) => {
		const canvas = within(canvasElement);

		await step('Verify Agent toggle is hidden on mobile', async () => {
			const agentToggle = canvas.queryByLabelText('Toggle Agent panel');
			await expect(agentToggle).not.toBeInTheDocument();
		});

		await step('Verify settings, deploy, download are hidden on mobile', async () => {
			await expect(canvas.queryByLabelText('Project settings')).not.toBeInTheDocument();
			await expect(canvas.queryByLabelText('Deploy to Cloudflare')).not.toBeInTheDocument();
			await expect(canvas.queryByLabelText('Download project')).not.toBeInTheDocument();
		});

		await step('Verify More menu exists on mobile', async () => {
			const moreMenu = await canvas.findByLabelText('More options');
			await expect(moreMenu).toBeInTheDocument();
		});
	},
};

export const EditingName: Story = {
	args: {
		agentPanelVisible: false,
		projectNameState: {
			projectName: 'New Name Edited',
			isEditingName: true,
			handleStartRename: fn(),
			handleSaveRename: fn(),
			handleCancelRename: fn(),
		},
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const input = await canvas.findByDisplayValue('New Name Edited');
		await expect(input).toBeInTheDocument();
	},
};
