import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import DashboardPage from './dashboard-page';

vi.mock('./dashboard-greeting', async () => {
	const actual = await vi.importActual<typeof import('./dashboard-greeting')>('./dashboard-greeting');

	return {
		...actual,
		getDashboardGreeting: vi.fn(actual.getDashboardGreeting),
	};
});

// Mock the API client
vi.mock('@/lib/api-client', () => ({
	createProject: vi.fn(),
	cloneProject: vi.fn(),
	deleteProject: vi.fn(() => Promise.resolve()),
	fetchTemplates: vi.fn(() =>
		Promise.resolve([
			{
				id: 'request-inspector',
				name: 'Request Inspector',
				description: 'Inspect incoming HTTP request headers, geolocation, and connection info.',
				icon: 'Search',
			},
		]),
	),
	fetchOrgProjects: vi.fn(() => Promise.resolve([])),
	fetchOrgLimits: vi.fn(() => Promise.resolve({ currentProjects: 0, maxProjects: 10 })),
	fetchUserLimits: vi.fn(() => Promise.resolve({ maxFreeOrganizations: 3, currentFreeOrganizations: 1 })),
}));

// Mock org switcher
vi.mock('@/features/org/org-switcher', () => ({
	OrgSwitcher: () => <div data-testid="org-switcher" />,
}));

// Mock user menu
vi.mock('@/features/user-menu', () => ({
	UserMenu: () => <div data-testid="user-menu" />,
}));

// Mock the HalftoneBackground — WebGL is not available in jsdom
vi.mock('@/components/halftone-background', () => ({
	HalftoneBackground: () => <canvas data-testid="halftone-background" />,
}));

function createTestQueryClient() {
	return new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
}

function QueryWrapper({ children }: { children: React.ReactNode }) {
	const [queryClient] = useState(createTestQueryClient);
	return (
		<MemoryRouter>
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		</MemoryRouter>
	);
}

function renderWithQuery(ui: React.ReactElement) {
	return render(ui, { wrapper: QueryWrapper });
}

function setLocalTime(isoDateTime: string) {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	vi.setSystemTime(new Date(isoDateTime));
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.resetAllMocks();
});

const { createProject, cloneProject, fetchOrgProjects, fetchOrgLimits } = await import('@/lib/api-client');
const { getDashboardGreeting } = await import('./dashboard-greeting');

type DashboardProject = Awaited<ReturnType<typeof fetchOrgProjects>>[number];

function makeProject(overrides: Partial<DashboardProject> = {}): DashboardProject {
	const timestamp = new Date().toISOString();

	/* eslint-disable unicorn/no-null -- Hono RPC infers nullable timestamps from Drizzle columns */
	return {
		id: '5ydvqzhiqckl5fa63nhky2pstb212hcdj0lk19eklkmc7snawe',
		organizationId: 'org1',
		durableObjectHexId: 'abc123',
		name: 'My Project',
		previewVisibility: 'public',
		createdAt: timestamp,
		updatedAt: timestamp,
		deletedAt: null,
		bannedAt: null,
		lastActivityAt: timestamp,
		...overrides,
	};
	/* eslint-enable unicorn/no-null */
}

const defaultProperties = {
	orgSlug: 'test-org',
	organizationId: 'org1',
	organizations: [{ id: 'org1', name: 'Test Org', slug: 'test-org' }],
	user: { name: 'Test User', email: 'test@example.com' },
};

describe('DashboardPage', () => {
	it('renders the dashboard greeting', async () => {
		setLocalTime('2026-04-27T01:00:00');
		const mockedGetDashboardGreeting = vi.mocked(getDashboardGreeting);
		mockedGetDashboardGreeting.mockReturnValueOnce('Dashboard test greeting');

		renderWithQuery(<DashboardPage {...defaultProperties} />);

		expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard test greeting' })).toBeInTheDocument();
		expect(mockedGetDashboardGreeting).toHaveBeenCalledWith('Test User');
	});

	it('falls back to the app name when the user name is blank', async () => {
		setLocalTime('2026-04-27T09:00:00');

		renderWithQuery(<DashboardPage {...defaultProperties} user={{ name: '   ', email: 'fallback-user@example.com' }} />);

		expect(await screen.findByRole('heading', { level: 1, name: 'Codemaxxing' })).toBeInTheDocument();
	});

	it('renders the halftone background', async () => {
		renderWithQuery(<DashboardPage {...defaultProperties} />);

		expect(await screen.findByTestId('halftone-background')).toBeInTheDocument();
	});

	it('renders template cards', async () => {
		renderWithQuery(<DashboardPage {...defaultProperties} />);

		expect(await screen.findByText('Start a new project')).toBeInTheDocument();
		await waitFor(() => {
			expect(screen.getByText('Request Inspector')).toBeInTheDocument();
		});
	});

	it('renders a clone card in the template grid', async () => {
		renderWithQuery(<DashboardPage {...defaultProperties} />);

		await waitFor(() => {
			const cloneCard = screen.getByText('Clone a project').closest('button');
			expect(cloneCard).toBeTruthy();
		});
	});

	it('opens clone modal when clone card is clicked', async () => {
		renderWithQuery(<DashboardPage {...defaultProperties} />);

		await waitFor(() => {
			expect(screen.getByText('Clone a project').closest('button')).toBeTruthy();
		});

		const cloneCard = screen.getByText('Clone a project').closest('button')!;
		fireEvent.click(cloneCard);

		await waitFor(() => {
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		const dialog = screen.getByRole('dialog');
		expect(within(dialog).getByPlaceholderText('Project URL or ID')).toBeInTheDocument();
	});

	it('renders user menu', async () => {
		renderWithQuery(<DashboardPage {...defaultProperties} />);

		expect(await screen.findByTestId('user-menu')).toBeInTheDocument();
	});

	// ---------------------------------------------------------------------------
	// Template detail modal
	// ---------------------------------------------------------------------------

	it('opens template detail modal when a card is clicked', async () => {
		renderWithQuery(<DashboardPage {...defaultProperties} />);

		// Wait for templates to load
		const templateButton = await waitFor(() => {
			const button = screen.getByText('Request Inspector').closest('button');
			expect(button).toBeTruthy();
			return button!;
		});
		fireEvent.click(templateButton);

		// Modal should be open with template details
		await waitFor(() => {
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		const dialog = screen.getByRole('dialog');
		expect(within(dialog).getByText('Request Inspector')).toBeInTheDocument();
		expect(within(dialog).getByText(/Inspect incoming HTTP request headers/)).toBeInTheDocument();
		expect(within(dialog).getByRole('button', { name: 'Create Project' })).toBeInTheDocument();
	});

	it('creates a project when Create Project is clicked in the modal', async () => {
		const mockedCreateProject = vi.mocked(createProject);
		mockedCreateProject.mockResolvedValueOnce({
			projectId: 'abc123',
			url: '/p/abc123',
			name: 'my-project',
		});

		renderWithQuery(<DashboardPage {...defaultProperties} />);

		// Open the detail modal
		const templateButton = await waitFor(() => {
			const button = screen.getByText('Request Inspector').closest('button');
			expect(button).toBeTruthy();
			return button!;
		});
		fireEvent.click(templateButton);

		// Click "Create Project" in the modal
		await waitFor(() => {
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});
		const createButton = within(screen.getByRole('dialog')).getByRole('button', { name: 'Create Project' });
		fireEvent.click(createButton);

		// Should show loading overlay
		expect(screen.getByText('Creating project...')).toBeInTheDocument();

		await waitFor(() => {
			expect(mockedCreateProject).toHaveBeenCalledWith('org1', 'request-inspector');
		});
	});

	it('closes the modal when Cancel is clicked', async () => {
		renderWithQuery(<DashboardPage {...defaultProperties} />);

		// Open the detail modal
		const templateButton = await waitFor(() => {
			const button = screen.getByText('Request Inspector').closest('button');
			expect(button).toBeTruthy();
			return button!;
		});
		fireEvent.click(templateButton);

		await waitFor(() => {
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		// Click Cancel
		const cancelButton = within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' });
		fireEvent.click(cancelButton);

		await waitFor(() => {
			expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		});
	});

	// ---------------------------------------------------------------------------
	// Clone input
	// ---------------------------------------------------------------------------

	it('disables clone button in modal when input is empty', async () => {
		renderWithQuery(<DashboardPage {...defaultProperties} />);

		// Open clone modal
		await waitFor(() => {
			expect(screen.getByText('Clone a project').closest('button')).toBeTruthy();
		});
		fireEvent.click(screen.getByText('Clone a project').closest('button')!);

		await waitFor(() => {
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		const dialog = screen.getByRole('dialog');
		const cloneButton = within(dialog).getByRole('button', { name: 'Clone' });
		expect(cloneButton).toBeDisabled();
	});

	it('enables clone button in modal when a valid project ID is entered', async () => {
		const user = userEvent.setup();
		renderWithQuery(<DashboardPage {...defaultProperties} />);

		// Open clone modal
		await waitFor(() => {
			expect(screen.getByText('Clone a project').closest('button')).toBeTruthy();
		});
		fireEvent.click(screen.getByText('Clone a project').closest('button')!);

		await waitFor(() => {
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		const dialog = screen.getByRole('dialog');
		const input = within(dialog).getByPlaceholderText('Project URL or ID');
		const validId = '494rtk7ddoepe5ru2lx4oc855i6lc23p3apolh04feq8q517sa';
		await user.type(input, validId);

		const cloneButton = within(dialog).getByRole('button', { name: 'Clone' });
		expect(cloneButton).not.toBeDisabled();
	});

	it('enables clone button in modal when a full project URL is entered', async () => {
		renderWithQuery(<DashboardPage {...defaultProperties} />);

		// Open clone modal
		await waitFor(() => {
			expect(screen.getByText('Clone a project').closest('button')).toBeTruthy();
		});
		fireEvent.click(screen.getByText('Clone a project').closest('button')!);

		await waitFor(() => {
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		const dialog = screen.getByRole('dialog');
		const input = within(dialog).getByPlaceholderText('Project URL or ID');
		const validUrl = `https://example.dev/p/${'4og1sx0wpug6bz5f2vb8qruk2geg9nwv786ngf3qgy79ljxqkb'}`;
		fireEvent.change(input, { target: { value: validUrl } });

		const cloneButton = within(dialog).getByRole('button', { name: 'Clone' });
		expect(cloneButton).not.toBeDisabled();
	});

	it('keeps clone button disabled for invalid input in modal', async () => {
		const user = userEvent.setup();
		renderWithQuery(<DashboardPage {...defaultProperties} />);

		// Open clone modal
		await waitFor(() => {
			expect(screen.getByText('Clone a project').closest('button')).toBeTruthy();
		});
		fireEvent.click(screen.getByText('Clone a project').closest('button')!);

		await waitFor(() => {
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		const dialog = screen.getByRole('dialog');
		const input = within(dialog).getByPlaceholderText('Project URL or ID');
		await user.type(input, 'not-a-valid-id');

		const cloneButton = within(dialog).getByRole('button', { name: 'Clone' });
		expect(cloneButton).toBeDisabled();
	});

	it('clones a project when clone button is clicked in modal', async () => {
		const user = userEvent.setup();
		const mockedCloneProject = vi.mocked(cloneProject);
		mockedCloneProject.mockResolvedValueOnce({
			projectId: 'new123',
			url: '/p/new123',
			name: 'cloned-project',
		});

		renderWithQuery(<DashboardPage {...defaultProperties} />);

		// Open clone modal
		await waitFor(() => {
			expect(screen.getByText('Clone a project').closest('button')).toBeTruthy();
		});
		fireEvent.click(screen.getByText('Clone a project').closest('button')!);

		await waitFor(() => {
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		const dialog = screen.getByRole('dialog');
		const input = within(dialog).getByPlaceholderText('Project URL or ID');
		const validId = '53rbs9ug20hn9sj034pct7gyzemb79q1b5nmbd7cihoagyu9cc';
		await user.type(input, validId);

		const cloneButton = within(dialog).getByRole('button', { name: 'Clone' });
		fireEvent.click(cloneButton);

		expect(screen.getByText('Cloning project...')).toBeInTheDocument();

		await waitFor(() => {
			expect(mockedCloneProject).toHaveBeenCalledWith('org1', validId);
		});
	});

	it('shows clone error message on failure', async () => {
		const user = userEvent.setup();
		const mockedCloneProject = vi.mocked(cloneProject);
		mockedCloneProject.mockRejectedValueOnce(new Error('Source project not found or not initialized'));

		renderWithQuery(<DashboardPage {...defaultProperties} />);

		// Open clone modal
		await waitFor(() => {
			expect(screen.getByText('Clone a project').closest('button')).toBeTruthy();
		});
		fireEvent.click(screen.getByText('Clone a project').closest('button')!);

		await waitFor(() => {
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		const dialog = screen.getByRole('dialog');
		const input = within(dialog).getByPlaceholderText('Project URL or ID');
		const validId = '5j2lrmnze6j47lwl3e3gvn3dwcu64vj7f34l6bayk15bcdqs4d';
		await user.type(input, validId);

		const cloneButton = within(dialog).getByRole('button', { name: 'Clone' });
		fireEvent.click(cloneButton);

		await waitFor(() => {
			expect(screen.getByText('Source project not found or not initialized')).toBeInTheDocument();
		});
	});

	// ---------------------------------------------------------------------------
	// Project limit reached
	// ---------------------------------------------------------------------------

	it('shows warning and disables Create Project button in template modal when project limit is reached', async () => {
		vi.mocked(fetchOrgLimits).mockResolvedValue({
			currentProjects: 10,
			maxProjects: 10,
			maxMembers: 5,
			currentMembers: 1,
			maxPendingInvitations: 10,
			currentPendingInvitations: 0,
		});

		renderWithQuery(<DashboardPage {...defaultProperties} />);

		// Open template detail modal
		const templateButton = await waitFor(() => {
			const button = screen.getByText('Request Inspector').closest('button');
			expect(button).toBeTruthy();
			return button!;
		});
		fireEvent.click(templateButton);

		await waitFor(() => {
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		const dialog = screen.getByRole('dialog');
		expect(within(dialog).getByText(/You have exceeded the maximum number of projects/)).toBeInTheDocument();
		expect(within(dialog).getByRole('button', { name: 'Create Project' })).toBeDisabled();
	});

	it('does not show warning in template modal when project limit is not reached', async () => {
		vi.mocked(fetchOrgLimits).mockResolvedValue({
			currentProjects: 5,
			maxProjects: 10,
			maxMembers: 5,
			currentMembers: 1,
			maxPendingInvitations: 10,
			currentPendingInvitations: 0,
		});

		renderWithQuery(<DashboardPage {...defaultProperties} />);

		const templateButton = await waitFor(() => {
			const button = screen.getByText('Request Inspector').closest('button');
			expect(button).toBeTruthy();
			return button!;
		});
		fireEvent.click(templateButton);

		await waitFor(() => {
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		const dialog = screen.getByRole('dialog');
		expect(within(dialog).queryByText(/You have exceeded the maximum number of projects/)).not.toBeInTheDocument();
		expect(within(dialog).getByRole('button', { name: 'Create Project' })).not.toBeDisabled();
	});

	it('shows warning and disables Clone button in clone modal when project limit is reached', async () => {
		const user = userEvent.setup();
		vi.mocked(fetchOrgLimits).mockResolvedValue({
			currentProjects: 10,
			maxProjects: 10,
			maxMembers: 5,
			currentMembers: 1,
			maxPendingInvitations: 10,
			currentPendingInvitations: 0,
		});

		renderWithQuery(<DashboardPage {...defaultProperties} />);

		// Open clone modal
		await waitFor(() => {
			expect(screen.getByText('Clone a project').closest('button')).toBeTruthy();
		});
		fireEvent.click(screen.getByText('Clone a project').closest('button')!);

		await waitFor(() => {
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		const dialog = screen.getByRole('dialog');

		// Enter a valid project ID
		const input = within(dialog).getByPlaceholderText('Project URL or ID');
		const validId = '494rtk7ddoepe5ru2lx4oc855i6lc23p3apolh04feq8q517sa';
		await user.type(input, validId);

		expect(within(dialog).getByText(/You have exceeded the maximum number of projects/)).toBeInTheDocument();
		expect(within(dialog).getByRole('button', { name: 'Clone' })).toBeDisabled();
	});

	// ---------------------------------------------------------------------------
	// Recent projects
	// ---------------------------------------------------------------------------

	it('does not render projects section when empty', () => {
		renderWithQuery(<DashboardPage {...defaultProperties} />);

		expect(screen.queryByText('Your projects')).not.toBeInTheDocument();
	});

	it('renders projects section with a single project', async () => {
		vi.mocked(fetchOrgProjects).mockResolvedValue([
			makeProject({
				createdAt: new Date(Date.now() - 3_600_000).toISOString(),
				updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
				lastActivityAt: new Date(Date.now() - 3_600_000).toISOString(),
			}),
		]);

		renderWithQuery(<DashboardPage {...defaultProperties} />);

		await waitFor(() => {
			expect(screen.getByText('Your projects')).toBeInTheDocument();
		});
		expect(screen.getByText('My Project')).toBeInTheDocument();
	});

	it('renders all projects when multiple available', async () => {
		vi.mocked(fetchOrgProjects).mockResolvedValue([
			makeProject({
				createdAt: new Date(Date.now() - 3_600_000).toISOString(),
				updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
				lastActivityAt: new Date(Date.now() - 3_600_000).toISOString(),
			}),
			makeProject({
				id: '6dp5qcb22im238nr3wvp0ic7q99w035jmy2iw7i6n43d37jtof',
				durableObjectHexId: 'def456',
				name: 'Old Project',
				createdAt: new Date(Date.now() - 86_400_000).toISOString(),
				updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
				lastActivityAt: new Date(Date.now() - 86_400_000).toISOString(),
			}),
		]);

		renderWithQuery(<DashboardPage {...defaultProperties} />);

		await waitFor(() => {
			expect(screen.getByText('Your projects')).toBeInTheDocument();
		});
		expect(screen.getByText('My Project')).toBeInTheDocument();
		expect(screen.getByText('Old Project')).toBeInTheDocument();
	});

	it('shows the latest access or activity time inline on project rows', async () => {
		setLocalTime('2026-04-28T09:15:00');
		vi.mocked(fetchOrgProjects).mockResolvedValue([
			makeProject({
				name: 'Recent Project',
				lastActivityAt: new Date('2026-04-28T09:10:00').toISOString(),
				updatedAt: new Date('2026-04-28T09:00:00').toISOString(),
			}),
		]);

		renderWithQuery(<DashboardPage {...defaultProperties} />);

		await waitFor(() => {
			expect(screen.getByText('Recent Project')).toBeInTheDocument();
		});

		expect(screen.getByText('5m ago')).toBeInTheDocument();
	});

	it('does not render an inline delete button on dashboard project rows', async () => {
		vi.mocked(fetchOrgProjects).mockResolvedValue([makeProject({ name: 'No Trash Project' })]);

		renderWithQuery(<DashboardPage {...defaultProperties} />);

		await waitFor(() => {
			expect(screen.getByText('No Trash Project')).toBeInTheDocument();
		});

		expect(screen.queryByLabelText('Delete No Trash Project')).not.toBeInTheDocument();
	});

	it('clears loading overlay when page is restored from bfcache (browser back)', async () => {
		const mockedCreateProject = vi.mocked(createProject);
		// Never resolves — simulates the navigation happening before promise settles
		mockedCreateProject.mockReturnValueOnce(new Promise(() => {}));

		renderWithQuery(<DashboardPage {...defaultProperties} />);

		// Open the detail modal
		const templateButton = await waitFor(() => {
			const button = screen.getByText('Request Inspector').closest('button');
			expect(button).toBeTruthy();
			return button!;
		});
		fireEvent.click(templateButton);

		await waitFor(() => {
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});
		const createButton = within(screen.getByRole('dialog')).getByRole('button', { name: 'Create Project' });
		fireEvent.click(createButton);

		// Loading overlay should be visible
		expect(screen.getByText('Creating project...')).toBeInTheDocument();

		// Simulate bfcache restore (browser back button)
		globalThis.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));

		// Loading overlay should be cleared
		await waitFor(() => {
			expect(screen.queryByText('Creating project...')).not.toBeInTheDocument();
		});
	});

	it('refreshes the project list when page is restored from bfcache', async () => {
		const mockedFetchOrgProjects = vi.mocked(fetchOrgProjects);
		mockedFetchOrgProjects
			.mockResolvedValueOnce([makeProject({ name: 'Old Project Name' })])
			.mockResolvedValueOnce([makeProject({ name: 'Renamed Project' })]);

		renderWithQuery(<DashboardPage {...defaultProperties} />);

		await waitFor(() => {
			expect(screen.getByText('Old Project Name')).toBeInTheDocument();
		});

		globalThis.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));

		await waitFor(() => {
			expect(screen.getByText('Renamed Project')).toBeInTheDocument();
		});
		expect(screen.queryByText('Old Project Name')).not.toBeInTheDocument();
	});

	it('project rows are links to the project page', async () => {
		const projectId = '494rtk7ddoepe5ru2lx4oc855i6lc23p3apolh04feq8q517sa';
		vi.mocked(fetchOrgProjects).mockResolvedValue([makeProject({ id: projectId, name: 'Test Project' })]);

		renderWithQuery(<DashboardPage {...defaultProperties} />);

		await waitFor(() => {
			expect(screen.getByText('Test Project')).toBeInTheDocument();
		});

		const link = screen.getByText('Test Project').closest('a');
		expect(link).toBeTruthy();
		expect(link?.getAttribute('href')).toBe(`/p/${projectId}`);
	});
});
