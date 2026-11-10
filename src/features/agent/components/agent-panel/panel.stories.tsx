import { useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';

import { DEFAULT_AI_MODEL } from '@shared/constants';

import { AgentPanel } from './panel';
import { AgentRuntimeContext } from '../agent-runtime-context';

import type { InputSegment } from '../../lib/input-segments';
import type { ImageAttachment } from '../agent-runtime-context';
import type { Meta, StoryObj } from '@storybook/react-vite';

function PanelPreview() {
	const [segments, setSegments] = useState<InputSegment[]>([]);
	const [cursorPosition, setCursorPosition] = useState(0);
	const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([]);
	return (
		<AgentRuntimeContext.Provider
			value={{
				agent: {
					identified: true,
					state: {
						ready: true,
						sessions: [
							{
								id: 'background',
								title: 'Check the build',
								createdAt: 1,
								updatedAt: 1,
								model: DEFAULT_AI_MODEL,
								mode: 'code',
								status: 'running',
								isRunning: true,
								revision: 1,
							},
						],
						reviewEntries: {},
						reviewSummary: { unresolvedCount: 0, reviewVersion: 0, sessionCounts: {} },
					},
					addEventListener: fn(),
					removeEventListener: fn(),
				},
				selectSession: fn(),
				agentConnectionState: 'connected',
				isConnected: true,
				segments,
				setSegments,
				cursorPosition,
				setCursorPosition,
				imageAttachments,
				setImageAttachments,
			}}
		>
			<AgentPanel projectId="story-project" />
		</AgentRuntimeContext.Provider>
	);
}

const meta = {
	title: 'Features/Agent/Panel',
	component: PanelPreview,
	decorators: [
		(Story) => (
			<div className="h-[680px] w-96 max-w-full border border-border text-text-primary">
				<Story />
			</div>
		),
	],
} satisfies Meta<typeof PanelPreview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NewSession: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByRole('button', { name: 'Send message' })).toBeEnabled();
		await userEvent.click(canvas.getByRole('button', { name: 'Session history' }));
		await expect(canvas.getByText('Check the build')).toBeVisible();
		await expect(canvas.getByText('1 running')).toBeVisible();
	},
};
export const Mobile: Story = {
	decorators: [
		(Story) => (
			<div className="h-full w-72">
				<Story />
			</div>
		),
	],
};
