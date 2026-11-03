import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api-client', () => ({
	fetchProjectMeta: vi.fn(),
	fetchStorageUsage: vi.fn(),
	updateProjectMeta: vi.fn(),
}));

import { fetchProjectMeta, fetchStorageUsage, updateProjectMeta } from '@/lib/api-client';

import { WranglerSettingsPanel } from './wrangler-settings-panel';

function createTestQueryClient() {
	return new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
}

function Wrapper({ children }: { children: React.ReactNode }) {
	const [queryClient] = useState(createTestQueryClient);
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function renderWithQuery(ui: React.ReactElement) {
	return render(ui, { wrapper: Wrapper });
}

describe('WranglerSettingsPanel', () => {
	it('refreshes storage quota after enabling object storage', async () => {
		const user = userEvent.setup();
		let storageEnabled = false;

		vi.mocked(fetchProjectMeta).mockImplementation(async () => ({
			name: 'demo-project',
			assetSettings: {},
			bindingsConfig: storageEnabled ? { storage: true } : {},
			alwaysUseContainer: false,
			organizationId: 'org-1',
			organizationSlug: 'demo-org',
			permissions: {
				delete: true,
				updateVisibility: true,
			},
		}));
		vi.mocked(fetchStorageUsage).mockImplementation(async () => ({
			usageBytes: 0,
			quotaBytes: storageEnabled ? 1024 : 0,
			enabled: storageEnabled,
		}));
		vi.mocked(updateProjectMeta).mockImplementation(async (_projectId, meta) => {
			storageEnabled = Boolean(meta.bindingsConfig?.storage);
			return {
				name: 'demo-project',
				assetSettings: meta.assetSettings,
				bindingsConfig: storageEnabled ? { storage: true } : {},
				alwaysUseContainer: false,
				organizationId: 'org-1',
				organizationSlug: 'demo-org',
				permissions: {
					delete: true,
					updateVisibility: true,
				},
			};
		});

		renderWithQuery(<WranglerSettingsPanel projectId="project-123" />);

		expect(await screen.findByText('Wrangler Configuration')).toBeInTheDocument();

		await user.click(screen.getByLabelText('Enable Object Storage'));
		await waitFor(() => {
			expect(screen.getByText('0 B / 0 B')).toBeInTheDocument();
		});

		await user.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() => {
			expect(updateProjectMeta).toHaveBeenCalledWith('project-123', {
				assetSettings: {},
				bindingsConfig: { storage: true },
			});
		});
		await waitFor(() => {
			expect(screen.getByText('0 B / 1 KB')).toBeInTheDocument();
		});
	});
});
