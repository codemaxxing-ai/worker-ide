import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { GlobalDialogBackdrop } from '@/components/ui/global-dialog-backdrop';
import { Modal, ModalBody } from '@/components/ui/modal';

import { ProjectSettingsModal } from './project-settings-modal';

const { mockCreateApiClient, mockFetchProjectMeta, mockVisibilityGet, mockUpdateProjectMeta } = vi.hoisted(() => ({
	mockCreateApiClient: vi.fn(),
	mockFetchProjectMeta: vi.fn(),
	mockVisibilityGet: vi.fn(),
	mockUpdateProjectMeta: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({
	createApiClient: mockCreateApiClient,
	fetchProjectMeta: mockFetchProjectMeta,
	updateProjectMeta: mockUpdateProjectMeta,
	deleteProject: vi.fn(),
}));

vi.mock('@/components/ui/toast-store', () => ({
	toast: {
		error: vi.fn(),
		success: vi.fn(),
	},
}));

vi.mock('@/lib/project-access', () => ({
	invalidateProjectAccess: vi.fn(),
}));

function createTestQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: { retry: false },
		},
	});
}

describe('ProjectSettingsModal', () => {
	it('saves the persistent container choice through metadata', async () => {
		const user = userEvent.setup();
		const visibilityPut = vi.fn(async () => Response.json({}));
		mockCreateApiClient.mockReturnValue({
			project: { visibility: { $get: async () => Response.json({ visibility: 'public' }), $put: visibilityPut } },
		});
		mockFetchProjectMeta.mockResolvedValue({
			name: 'Example',
			organizationId: 'org',
			alwaysUseContainer: false,
			permissions: { delete: true, updateVisibility: true },
		});
		mockUpdateProjectMeta.mockResolvedValue({ alwaysUseContainer: true });
		render(
			<QueryClientProvider client={createTestQueryClient()}>
				<MemoryRouter>
					<ProjectSettingsModal open onOpenChange={vi.fn()} projectId="project" />
				</MemoryRouter>
			</QueryClientProvider>,
		);
		const runtime = await screen.findByRole('group', { name: 'Runtime' });
		const toggle = within(runtime).getByRole('switch', { name: 'Always use a container' });
		expect(toggle).not.toBeChecked();
		toggle.focus();
		await user.keyboard(' ');
		expect(toggle).toBeChecked();
		await user.click(screen.getByRole('button', { name: /Save/ }));
		expect(mockUpdateProjectMeta).toHaveBeenCalledWith('project', { alwaysUseContainer: true });
	});
	it('keeps the shared backdrop visible while switching from the mobile More modal to project settings during loading', async () => {
		const user = userEvent.setup();
		const neverResolvingPromise = new Promise<never>(() => {});

		mockCreateApiClient.mockReturnValue({
			project: {
				visibility: {
					$get: mockVisibilityGet,
					$put: vi.fn(),
				},
			},
		});
		mockVisibilityGet.mockReturnValue(neverResolvingPromise);
		mockFetchProjectMeta.mockReturnValue(neverResolvingPromise);

		function MobileMenuSettingsTransitionExample() {
			const [mobileMenuOpen, setMobileMenuOpen] = useState(true);
			const [settingsOpen, setSettingsOpen] = useState(false);

			return (
				<>
					<GlobalDialogBackdrop />
					<Modal open={mobileMenuOpen} onOpenChange={setMobileMenuOpen} title="More">
						<ModalBody>
							<button
								type="button"
								onClick={() => {
									setSettingsOpen(true);
									setMobileMenuOpen(false);
								}}
							>
								Project settings
							</button>
						</ModalBody>
					</Modal>
					<ProjectSettingsModal open={settingsOpen} onOpenChange={setSettingsOpen} projectId="project-123" />
				</>
			);
		}

		render(
			<QueryClientProvider client={createTestQueryClient()}>
				<MemoryRouter>
					<MobileMenuSettingsTransitionExample />
				</MemoryRouter>
			</QueryClientProvider>,
		);

		expect(screen.getByRole('dialog', { hidden: true, name: 'More' })).toBeInTheDocument();
		const backdropBefore = screen.getByTestId('modal-backdrop');

		await user.click(screen.getByRole('button', { name: 'Project settings' }));

		expect(screen.getByRole('dialog', { hidden: true, name: 'Project Settings' })).toBeInTheDocument();
		const backdropAfter = screen.getByTestId('modal-backdrop');
		expect(backdropAfter).toBe(backdropBefore);
	});
});
