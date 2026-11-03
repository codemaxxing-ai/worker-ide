import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DeployModal } from './deploy-modal';

import type { ProjectMeta } from '@/lib/api-client';
import type { CloudflareAccount, CloudflareConnectionStatus } from '@shared/deploy-types';
import type { FileInfo } from '@shared/types';
import type { ReactElement, ReactNode } from 'react';

const DEFAULT_PROJECT_ID = 'abc123';

const mockGetCloudflareConnection = vi.fn<() => Promise<CloudflareConnectionStatus>>();
const mockListCloudflareAccounts = vi.fn<() => Promise<CloudflareAccount[]>>();
const mockDisconnectCloudflare = vi.fn<() => Promise<void>>();
const mockStartDeployProject = vi.fn();

vi.mock('@/lib/api-client', () => ({
	getCloudflareConnection: () => mockGetCloudflareConnection(),
	listCloudflareAccounts: () => mockListCloudflareAccounts(),
	disconnectCloudflare: () => mockDisconnectCloudflare(),
	startDeployProject: (...arguments_: unknown[]) => mockStartDeployProject(...arguments_),
	getDeployStatus: vi.fn(),
}));

function createProjectMeta(overrides: Partial<ProjectMeta> = {}): ProjectMeta {
	return {
		name: 'my-project',
		alwaysUseContainer: false,
		organizationId: 'org-1',
		permissions: {
			delete: true,
			updateVisibility: true,
		},
		...overrides,
	};
}

function createTestQueryClient(projectMeta?: ProjectMeta, files?: FileInfo[]) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});

	if (projectMeta) {
		queryClient.setQueryData(['project-meta', DEFAULT_PROJECT_ID], projectMeta);
	}
	if (files) {
		queryClient.setQueryData(['files', DEFAULT_PROJECT_ID], files);
	}

	return queryClient;
}

function renderWithQueryClient(ui: ReactElement, projectMeta?: ProjectMeta, files?: FileInfo[]) {
	const queryClient = createTestQueryClient(projectMeta, files);
	function Wrapper({ children }: { children: ReactNode }) {
		return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
	}

	return render(ui, { wrapper: Wrapper });
}

function renderDeployModal(projectName = 'my-project', projectMeta?: ProjectMeta, files?: FileInfo[]) {
	return renderWithQueryClient(
		<DeployModal open={true} onOpenChange={vi.fn()} projectId={DEFAULT_PROJECT_ID} projectName={projectName} />,
		projectMeta,
		files,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	mockGetCloudflareConnection.mockResolvedValue({ connected: true, email: 'dev@example.com' });
	mockListCloudflareAccounts.mockResolvedValue([
		{ id: 'd64471fef208e0cf9687449dc8a5878b', name: 'My Account' },
		{ id: 'aabbccddeeff00112233445566778899', name: 'Second Account' },
	]);
	mockDisconnectCloudflare.mockResolvedValue();
	mockStartDeployProject.mockResolvedValue({ instanceId: 'deploy-1' });
});

describe('DeployModal', () => {
	it('renders the modal title when open', () => {
		renderDeployModal();

		expect(screen.getByText('Deploy to Cloudflare')).toBeInTheDocument();
	});

	it('does not render content when closed', () => {
		renderWithQueryClient(<DeployModal open={false} onOpenChange={vi.fn()} projectId={DEFAULT_PROJECT_ID} projectName="my-project" />);

		expect(screen.queryByText('Deploy to Cloudflare')).not.toBeInTheDocument();
	});

	it('prompts to connect when no Cloudflare connection exists', async () => {
		mockGetCloudflareConnection.mockResolvedValue({ connected: false });
		renderDeployModal();

		expect(await screen.findByRole('button', { name: /connect to cloudflare/i })).toBeInTheDocument();
		expect(screen.queryByLabelText('Cloudflare Account')).not.toBeInTheDocument();
	});

	it('offers a temporary deployment when no Cloudflare connection exists', async () => {
		mockGetCloudflareConnection.mockResolvedValue({ connected: false });
		renderDeployModal();

		const deployButton = await screen.findByRole('button', { name: /deploy to new account/i });
		expect(deployButton).toBeEnabled();
		expect(screen.getByRole('button', { name: /connect to cloudflare/i })).toBeInTheDocument();

		await userEvent.setup().click(deployButton);

		expect(mockStartDeployProject).toHaveBeenCalledWith(DEFAULT_PROJECT_ID, { mode: 'temporary' });
	});

	it('disables temporary deployment for projects with R2 storage', async () => {
		mockGetCloudflareConnection.mockResolvedValue({ connected: false });
		renderDeployModal('my-project', createProjectMeta({ bindingsConfig: { storage: true } }));

		expect(await screen.findByRole('button', { name: /deploy to new account/i })).toBeDisabled();
		expect(screen.getByText(/temporary accounts do not support/i)).toBeInTheDocument();
	});

	it('shows the connected account email and account selector once connected', async () => {
		renderDeployModal();

		expect(await screen.findByText(/connected as dev@example.com/i)).toBeInTheDocument();
		const accountSelect = await screen.findByLabelText('Cloudflare Account');
		expect(accountSelect).toBeInTheDocument();
		expect(screen.getByRole('option', { name: 'My Account' })).toBeInTheDocument();
		expect(screen.getByRole('option', { name: 'Second Account' })).toBeInTheDocument();
	});

	it('renders Worker Name input with sanitized project name', async () => {
		renderDeployModal('My Project');

		const nameInput = await screen.findByLabelText('Worker Name');
		expect(nameInput).toHaveValue('my-project');
	});

	it('renders Deploy and Cancel buttons when connected', async () => {
		renderDeployModal();

		expect(await screen.findByRole('button', { name: /deploy/i })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
	});

	it('enables Deploy when an account is selected and worker name is valid', async () => {
		renderDeployModal();

		const deployButton = await screen.findByRole('button', { name: /deploy/i });
		await waitFor(() => expect(deployButton).toBeEnabled());
	});

	it('disables Deploy when the worker name is invalid', async () => {
		const user = userEvent.setup();
		renderDeployModal();

		const workerInput = await screen.findByLabelText('Worker Name');
		await user.clear(workerInput);
		await user.type(workerInput, 'a'.repeat(25));
		await user.tab();

		expect(screen.getByText('Worker name must be at most 24 characters')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /deploy/i })).toBeDisabled();
	});

	it('calls disconnect when Disconnect is clicked', async () => {
		const user = userEvent.setup();
		renderDeployModal();

		const disconnect = await screen.findByRole('button', { name: /disconnect/i });
		await user.click(disconnect);

		expect(mockDisconnectCloudflare).toHaveBeenCalled();
	});

	it('shows default deployment resources', async () => {
		renderDeployModal();

		expect(await screen.findByLabelText('Resources to deploy')).toBeInTheDocument();
		expect(screen.getByText('Worker')).toBeInTheDocument();
		expect(screen.getByText('Route')).toBeInTheDocument();
		expect(screen.getByText('my-project.workers.dev')).toBeInTheDocument();
		expect(screen.queryByText('Assets')).not.toBeInTheDocument();
		expect(screen.queryByText('R2 bucket')).not.toBeInTheDocument();
	});

	it('shows static assets when index.html exists', async () => {
		renderDeployModal('my-project', undefined, [{ path: '/index.html', name: 'index.html', isDirectory: false }]);

		expect(await screen.findByText('Assets')).toBeInTheDocument();
		expect(screen.getByText('Static assets')).toBeInTheDocument();
	});

	it('shows R2 bucket when storage is enabled', async () => {
		renderDeployModal('my-project', createProjectMeta({ bindingsConfig: { storage: true } }));

		expect(await screen.findByText('R2 bucket')).toBeInTheDocument();
		expect(screen.getByText(/^my-project-storage-[\da-f]{8}$/)).toBeInTheDocument();
	});

	it('updates resource names when the worker name changes', async () => {
		const user = userEvent.setup();
		renderDeployModal('my-project', createProjectMeta({ bindingsConfig: { storage: true } }));

		const workerInput = await screen.findByLabelText('Worker Name');
		await user.clear(workerInput);
		await user.type(workerInput, 'My New Worker');

		expect(screen.getByText('my-new-worker')).toBeInTheDocument();
		expect(screen.getByText('my-new-worker.workers.dev')).toBeInTheDocument();
		expect(screen.getByText(/^my-new-worker-storage-[\da-f]{8}$/)).toBeInTheDocument();
	});

	it('calls onOpenChange when Cancel is clicked', async () => {
		const user = userEvent.setup();
		const onOpenChange = vi.fn();
		renderWithQueryClient(<DeployModal open={true} onOpenChange={onOpenChange} projectId={DEFAULT_PROJECT_ID} projectName="my-project" />);

		await user.click(await screen.findByRole('button', { name: /cancel/i }));

		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});
