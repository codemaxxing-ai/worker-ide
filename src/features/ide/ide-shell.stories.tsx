import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Suspense } from 'react';
import { MemoryRouter } from 'react-router';
import { expect, within } from 'storybook/test';

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			retry: false,
		},
	},
});

import { IDEShell } from './ide-shell';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
	title: 'IDE/IDEShell',
	component: IDEShell,
	parameters: {
		layout: 'fullscreen',
	},
	tags: ['autodocs'],
	args: {
		projectId: '494rtk7ddoepe5ru2lx4oc855i6lc23p3apolh04feq8q517sa',
	},
	decorators: [
		(Story) => (
			<MemoryRouter>
				<QueryClientProvider client={queryClient}>
					<Suspense fallback={<div>Loading IDE Shell...</div>}>
						<Story />
					</Suspense>
				</QueryClientProvider>
			</MemoryRouter>
		),
	],
} satisfies Meta<typeof IDEShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DefaultRender: Story = {
	play: async ({ canvasElement, step }) => {
		const canvas = within(canvasElement);

		await step('Verify IDE Shell mounts', async () => {
			// It should render the header and the status bar at least
			const header = await canvas.findByRole('banner'); // header element
			await expect(header).toBeInTheDocument();

			const footer = await canvas.findByRole('contentinfo'); // footer element
			await expect(footer).toBeInTheDocument();
		});
	},
};
