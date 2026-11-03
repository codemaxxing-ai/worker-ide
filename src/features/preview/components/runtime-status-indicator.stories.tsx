import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

import { emptyRuntimeStatus } from '@shared/runtime-status';

import { RuntimeStatusIndicator } from './runtime-status-indicator';

import type { RuntimeStatus } from '@shared/runtime-status';
import type { Meta, StoryObj } from '@storybook/react-vite';

function RuntimeExample({ preview }: { preview: RuntimeStatus['preview'] }) {
	const [client] = useState(() => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
		queryClient.setQueryData(['runtime-status', 'example'], { ...emptyRuntimeStatus(), preview, revision: 1 });
		return queryClient;
	});
	return (
		<QueryClientProvider client={client}>
			<RuntimeStatusIndicator projectId="example" previewOrigin={undefined} iframeReference={{ current: undefined }} />
		</QueryClientProvider>
	);
}

const meta = { title: 'Preview/Runtime', component: RuntimeExample } satisfies Meta<typeof RuntimeExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Worker: Story = { args: { preview: { backend: 'worker', phase: 'ready', generation: 1 } } };
export const NativeContainer: Story = { args: { preview: { backend: 'container', phase: 'ready', generation: 1 } } };
export const Starting: Story = { args: { preview: { backend: 'worker', target: 'container', phase: 'switching', generation: 1 } } };
export const AtCapacity: Story = {
	args: {
		preview: {
			backend: 'worker',
			target: 'container',
			phase: 'blocked',
			capacity: { currentRunningContainers: 3, maxRunningContainers: 3 },
			generation: 1,
		},
	},
};
export const Failed: Story = { args: { preview: { backend: 'worker', target: 'container', phase: 'error', generation: 1 } } };
export const Sleeping: Story = { args: { preview: { backend: 'container', phase: 'sleeping', generation: 1 } } };
