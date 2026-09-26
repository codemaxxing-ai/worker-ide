import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Bug, Github, Hexagon } from 'lucide-react';
import { motion } from 'motion/react';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

import { HalftoneBackground } from '@/components/halftone-background';
import { PageHeader } from '@/components/page-header';
import { PageContentSkeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast-store';
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip';
import { VersionBadge } from '@/components/version-badge';
import { LoadingOverlay } from '@/features/dashboard/components/dashboard-loading-overlay';
import {
	CloneCard,
	CloneModal,
	TemplateCard,
	TemplateCardSkeleton,
	TemplateDetailModal,
} from '@/features/dashboard/components/dashboard-project-options';
import { ProjectRow } from '@/features/dashboard/components/dashboard-project-row';
import { getDashboardGreeting } from '@/features/dashboard/dashboard-greeting';
import { extractProjectId } from '@/features/dashboard/dashboard-project-id';
import { CreateOrgModal } from '@/features/org/create-org-modal';
import { PendingInvitationsBanner } from '@/features/org/pending-invitations-banner';
import { cloneProject, createProject, fetchOrgLimits, fetchOrgProjects, fetchTemplates, fetchUserLimits } from '@/lib/api-client';
import { fadeUpVariants, springGentle, staggerContainer } from '@/lib/motion-config';
import { getProjectUrl } from '@/lib/preview-origin';
import { cn } from '@/lib/utils';
import { isValidProjectId } from '@shared/project-id';

interface DashboardUser {
	name: string;
	email: string;
	image?: string;
}

/**
 * Dashboard page component.
 * Default export for React.lazy() compatibility.
 */
interface DashboardPageProperties {
	organizationId: string;
	organizations: Array<{ id: string; name: string; slug: string; plan?: string }>;
	isCreateOrgMode?: boolean;
	user?: DashboardUser;
}

export default function DashboardPage({ organizationId, organizations, isCreateOrgMode, user }: DashboardPageProperties) {
	const navigate = useNavigate();
	const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | undefined>();
	const [createOrgOpen, setCreateOrgOpen] = useState(!!isCreateOrgMode);
	const [selectedTemplateId, setSelectedTemplateId] = useState<string | undefined>();
	const [cloneInput, setCloneInput] = useState('');
	const [cloneModalOpen, setCloneModalOpen] = useState(false);
	const [loadingMessage, setLoadingMessage] = useState<string | undefined>();
	const [cloneError, setCloneError] = useState<string | undefined>();

	// Fetch template metadata from the API
	const templatesQuery = useQuery({
		queryKey: ['templates'],
		queryFn: fetchTemplates,
		staleTime: 1000 * 60 * 5,
	});
	const templates = useMemo(() => templatesQuery.data ?? [], [templatesQuery.data]);
	const templatesLoaded = !templatesQuery.isLoading;

	// Fetch org projects from D1
	const projectsQuery = useQuery({
		queryKey: ['org-projects', organizationId],
		queryFn: () => fetchOrgProjects(organizationId),
		staleTime: 1000 * 30,
		enabled: !isCreateOrgMode && !!organizationId,
	});
	const orgProjects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data]);

	// Fetch resolved org limits (plan-based + entitlement overrides)
	const limitsQuery = useQuery({
		queryKey: ['org-limits', organizationId],
		queryFn: () => fetchOrgLimits(organizationId),
		staleTime: 1000 * 60,
		enabled: !isCreateOrgMode && !!organizationId,
	});
	const orgLimits = limitsQuery.data;

	const selectedTemplate = useMemo(() => templates.find((template) => template.id === selectedTemplateId), [templates, selectedTemplateId]);

	const parsedProjectId = useMemo(() => {
		if (!cloneInput.trim()) return;
		const candidate = extractProjectId(cloneInput.trim());
		return candidate && isValidProjectId(candidate) ? candidate : undefined;
	}, [cloneInput]);

	// --- Handlers ---

	const handleSelectTemplate = useCallback((templateId: string) => {
		setSelectedTemplateId(templateId);
	}, []);

	const handleCloseTemplateModal = useCallback((open: boolean) => {
		if (!open) {
			setSelectedTemplateId(undefined);
		}
	}, []);

	const queryClient = useQueryClient();

	const handleCreateFromTemplate = useCallback(
		async (templateId: string) => {
			setLoadingMessage('Creating project...');
			try {
				const data = await createProject(organizationId, templateId);
				void queryClient.invalidateQueries({ queryKey: ['org-projects'] });
				void queryClient.invalidateQueries({ queryKey: ['org-limits'] });
				void navigate(getProjectUrl(data.projectId));
			} catch {
				setLoadingMessage(undefined);
				toast.error('Could not create the project. Please try again.');
			}
		},
		[organizationId, queryClient, navigate],
	);

	const handleOpenCloneModal = useCallback(() => {
		setCloneModalOpen(true);
		setCloneInput('');
		setCloneError(undefined);
	}, []);

	const handleCloseCloneModal = useCallback((open: boolean) => {
		if (!open) {
			setCloneModalOpen(false);
			setCloneError(undefined);
		}
	}, []);

	const handleCloneInputChange = useCallback((value: string) => {
		setCloneInput(value);
		setCloneError(undefined);
	}, []);

	const handleClone = useCallback(async () => {
		if (!parsedProjectId) return;

		setCloneError(undefined);
		setLoadingMessage('Cloning project...');
		try {
			const data = await cloneProject(organizationId, parsedProjectId);
			void queryClient.invalidateQueries({ queryKey: ['org-projects'] });
			void queryClient.invalidateQueries({ queryKey: ['org-limits'] });
			void navigate(getProjectUrl(data.projectId));
		} catch (error) {
			setLoadingMessage(undefined);
			setCloneError(error instanceof Error ? error.message : 'Failed to clone project');
		}
	}, [organizationId, parsedProjectId, queryClient, navigate]);

	const isLoading = loadingMessage !== undefined;

	const dashboardGreeting = useMemo(() => {
		const greetingName = user?.name.trim();
		if (!greetingName) {
			return 'Codemaxxing';
		}

		return getDashboardGreeting(greetingName);
	}, [user]);

	// Clear loading state when the page is restored from bfcache (browser back/forward)
	useEffect(() => {
		function handlePageShow(event: PageTransitionEvent) {
			if (event.persisted) {
				setLoadingMessage(undefined);
				setSelectedTemplateId(undefined);
				setCloneModalOpen(false);
				void queryClient.invalidateQueries({ queryKey: ['org-projects', organizationId] });
				void queryClient.invalidateQueries({ queryKey: ['org-limits', organizationId] });
			}
		}
		globalThis.addEventListener('pageshow', handlePageShow);
		return () => globalThis.removeEventListener('pageshow', handlePageShow);
	}, [organizationId, queryClient]);

	const hasNoOrgs = organizations.length === 0;
	const userLimitsQuery = useQuery({
		queryKey: ['user-limits'],
		queryFn: fetchUserLimits,
		staleTime: 1000 * 60,
	});
	const isLoadingOrganizationData = !isCreateOrgMode && (projectsQuery.isPending || limitsQuery.isPending);

	if (isLoadingOrganizationData) {
		return <PageContentSkeleton />;
	}

	return (
		<div ref={(element) => setScrollContainer(element ?? undefined)} className="relative isolate h-dvh overflow-y-auto">
			<Suspense fallback={undefined}>
				<HalftoneBackground />
			</Suspense>

			<PageHeader
				variant="floating"
				scrollContainer={scrollContainer}
				organizationSwitcher={
					isCreateOrgMode
						? undefined
						: {
								organizations,
								currentOrganizationId: organizationId,
								currentOrganizationName: organizations.find((organization) => organization.id === organizationId)?.name ?? '',
							}
				}
			/>

			{isLoading && <LoadingOverlay message={loadingMessage} />}

			<TemplateDetailModal
				template={selectedTemplate}
				open={selectedTemplateId !== undefined && !isLoading}
				onOpenChange={handleCloseTemplateModal}
				onCreateProject={handleCreateFromTemplate}
				isLoading={isLoading}
				projectLimitReached={orgLimits !== undefined && orgLimits.currentProjects >= orgLimits.maxProjects}
			/>

			<CreateOrgModal
				open={createOrgOpen}
				onOpenChange={setCreateOrgOpen}
				freeOrganizationCount={userLimitsQuery.data?.currentFreeOrganizations ?? 0}
				maxFreeOrganizations={userLimitsQuery.data?.maxFreeOrganizations}
				required={hasNoOrgs}
				userName={user?.name}
			/>

			<CloneModal
				open={cloneModalOpen && !isLoading}
				onOpenChange={handleCloseCloneModal}
				cloneInput={cloneInput}
				onCloneInputChange={handleCloneInputChange}
				parsedProjectId={parsedProjectId}
				onClone={() => void handleClone()}
				cloneError={cloneError}
				isLoading={isLoading}
				projectLimitReached={orgLimits !== undefined && orgLimits.currentProjects >= orgLimits.maxProjects}
			/>

			<main
				className="
					relative z-0 mx-auto w-full max-w-lg px-6 pt-24 pb-12
					sm:pt-32
				"
			>
				<motion.div
					className="mb-10 flex flex-col items-center gap-3"
					initial={{ opacity: 0, y: 10 }}
					animate={{ opacity: 1, y: 0 }}
					transition={springGentle}
				>
					<motion.div className="flex items-center justify-center">
						<Hexagon className="size-8 text-accent" strokeWidth={1.5} />
					</motion.div>
					<h1
						className="
							text-center text-xl font-semibold tracking-tight text-text-primary
						"
					>
						{dashboardGreeting}
					</h1>
				</motion.div>

				<section className="mb-8">
					<h2
						className="
							mb-3 text-xs font-medium tracking-wider text-text-secondary uppercase
						"
					>
						Start a new project
						{orgLimits && (
							<span className="ml-1 tracking-normal normal-case">
								({orgLimits.currentProjects}/{orgLimits.maxProjects})
							</span>
						)}
					</h2>

					<motion.div
						className="
							grid grid-cols-3 gap-2
							sm:grid-cols-4
						"
						variants={staggerContainer(0.05)}
						initial="hidden"
						animate="visible"
					>
						{templatesQuery.isError ? (
							<div className="col-span-full py-4 text-center text-sm text-text-secondary">
								Could not load templates.{' '}
								<button
									onClick={() => void templatesQuery.refetch()}
									className="
										cursor-pointer text-accent underline
										hover:text-accent-hover
									"
								>
									Retry
								</button>
							</div>
						) : templatesLoaded ? (
							<>
								{templates.map((template) => (
									<motion.div key={template.id} variants={fadeUpVariants} transition={springGentle}>
										<TemplateCard template={template} onSelect={handleSelectTemplate} disabled={isLoading} />
									</motion.div>
								))}
								<motion.div variants={fadeUpVariants} transition={springGentle}>
									<CloneCard onSelect={handleOpenCloneModal} disabled={isLoading} />
								</motion.div>
							</>
						) : (
							Array.from({ length: 4 }, (_, index) => <TemplateCardSkeleton key={index} />)
						)}
					</motion.div>
				</section>

				<PendingInvitationsBanner />

				{projectsQuery.isError && (
					<section className="mb-8">
						<div
							className="
								rounded-lg border border-border bg-bg-secondary/40 p-4 text-center
								text-sm text-text-secondary backdrop-blur-sm
							"
						>
							Could not load your projects.{' '}
							<button onClick={() => void projectsQuery.refetch()} className="cursor-pointer text-accent underline hover:text-accent-hover">
								Retry
							</button>
						</div>
					</section>
				)}
				{orgProjects.length > 0 && (
					<section>
						<h2
							className="
								mb-3 text-xs font-medium tracking-wider text-text-secondary uppercase
							"
						>
							Your projects
						</h2>
						<div
							className={cn(
								`
									max-h-46 overflow-y-auto rounded-lg border border-border
									bg-bg-secondary/40 backdrop-blur-sm
								`,
								'divide-y divide-border',
							)}
						>
							{orgProjects.map((project) => (
								<ProjectRow key={project.id} project={project} />
							))}
						</div>
					</section>
				)}
			</main>
			<TooltipProvider>
				<div
					className="
						fixed right-4 bottom-4 flex items-center gap-4 text-xs text-text-secondary
					"
				>
					<Tooltip content="GitHub">
						<a
							href="https://github.com/codemaxxing-ai/worker-ide"
							target="_blank"
							rel="noopener noreferrer"
							aria-label="GitHub repository"
							className="
								rounded-sm transition-colors
								hover:text-accent
								focus-visible:text-accent
							"
						>
							<Github className="size-3.5" />
						</a>
					</Tooltip>
					<Tooltip content="Report a bug">
						<a
							href="https://github.com/codemaxxing-ai/worker-ide/issues/new?template=bug-report.yml"
							target="_blank"
							rel="noopener noreferrer"
							className="
								rounded-sm transition-colors
								hover:text-accent
								focus-visible:text-accent
							"
						>
							<Bug className="size-3.5" />
						</a>
					</Tooltip>
					<Tooltip content="Docs">
						<a
							href="/docs"
							target="_blank"
							rel="noopener noreferrer"
							aria-label="Architecture docs"
							className="
								rounded-sm transition-colors
								hover:text-accent
								focus-visible:text-accent
							"
						>
							<BookOpen className="size-3.5" />
						</a>
					</Tooltip>
					<VersionBadge withProvider={false} />
				</div>
			</TooltipProvider>
		</div>
	);
}
