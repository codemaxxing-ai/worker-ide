import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';

import { ProjectSettingsModal } from './project-settings-modal';

import type { ProjectMeta } from './api/project';
import type { Meta, StoryObj } from '@storybook/react-vite';

function ProjectSettingsExample({ alwaysUseContainer }: { alwaysUseContainer: boolean }) {
	const [open, setOpen] = useState(true);
	const [client] = useState(() => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
		const project: ProjectMeta = {
			name: 'Example project',
			organizationId: 'example',
			alwaysUseContainer,
			permissions: { delete: true, updateVisibility: true },
		};
		queryClient.setQueryData(['project-meta', 'example'], project);
		queryClient.setQueryData(['project-visibility', 'example'], 'public');
		return queryClient;
	});
	return (
		<QueryClientProvider client={client}>
			<MemoryRouter>
				<ProjectSettingsModal open={open} onOpenChange={setOpen} projectId="example" />
			</MemoryRouter>
		</QueryClientProvider>
	);
}

const meta = { title: 'Project/Settings', component: ProjectSettingsExample } satisfies Meta<typeof ProjectSettingsExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Automatic: Story = { args: { alwaysUseContainer: false } };
export const AlwaysContainer: Story = { args: { alwaysUseContainer: true } };
