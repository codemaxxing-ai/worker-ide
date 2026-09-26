import { expect, within } from 'storybook/test';

import { IDEStatusBar } from './ide-status-bar';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
	title: 'IDE/IDEStatusBar',
	component: IDEStatusBar,
	parameters: {
		layout: 'fullscreen',
	},
	tags: ['autodocs'],
	decorators: [
		(Story) => (
			<div className="flex h-screen flex-col bg-bg-primary">
				<div className="flex-1" />
				<Story />
			</div>
		),
	],
} satisfies Meta<typeof IDEStatusBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ConnectedSolo: Story = {
	args: {
		isConnected: true,
		localParticipantColor: '#10b981',
		participants: [],
		isSaving: false,
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(await canvas.findByText('Connected')).toBeInTheDocument();
		await expect(canvas.queryByText(/online/i)).not.toBeInTheDocument();
	},
};

export const WithCollaborators: Story = {
	args: {
		isConnected: true,
		localParticipantColor: '#10b981',
		participants: [
			{ id: 'user-1', color: '#f59e0b' },
			{ id: 'user-2', color: '#3b82f6' },
		],
		isSaving: false,
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(await canvas.findByText('Connected')).toBeInTheDocument();
		await expect(await canvas.findByText('2 online')).toBeInTheDocument();
	},
};

export const Reconnecting: Story = {
	args: {
		isConnected: false,
		localParticipantColor: '#10b981',
		participants: [],
		isSaving: false,
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(await canvas.findByText('Reconnecting')).toBeInTheDocument();
	},
};

export const Disconnected: Story = {
	args: {
		isConnected: false,
		localParticipantColor: undefined,
		participants: [],
		isSaving: false,
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(await canvas.findByText('Disconnected')).toBeInTheDocument();
	},
};

export const Saving: Story = {
	args: {
		isConnected: true,
		localParticipantColor: '#10b981',
		participants: [],
		isSaving: true,
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(await canvas.findByText('Connected')).toBeInTheDocument();
		await expect(await canvas.findByText('Saving...')).toBeInTheDocument();
	},
};
