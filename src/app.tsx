import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Check, ClipboardCopy } from 'lucide-react';
import { motion } from 'motion/react';
import { Suspense, use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation, useParams, useSearchParams } from 'react-router';

import { AppDocumentMetadata } from '@/components/app-document-metadata';
import { ErrorBoundary } from '@/components/error-boundary';
import { NotFoundPage } from '@/components/not-found-page';
import { OfflineBanner } from '@/components/offline-banner';
import { ProjectAccessRestricted } from '@/components/project-access-restricted';
import { ProjectNotFound } from '@/components/project-not-found';
import { GlobalDialogBackdrop } from '@/components/ui/global-dialog-backdrop';
import { OrganizationManagementSkeleton, PageContentSkeleton, SettingsContentSkeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Toaster } from '@/components/ui/toast';
import { toast } from '@/components/ui/toast-store';
import { AppearanceModal } from '@/features/appearance';
import { LoginPage } from '@/features/auth';
import { DashboardPage } from '@/features/dashboard';
import { IDEShell } from '@/features/ide';
import { OrgManagementPage } from '@/features/org';
import { AccountPage, ProfilePage, SettingsLayout } from '@/features/settings';
import { useEditorFont } from '@/hooks/use-editor-font';
import { usePwaUpdate } from '@/hooks/use-pwa-update';
import { useTheme } from '@/hooks/use-theme';
import { useUserPreferences } from '@/hooks/use-user-preferences';
import { authClient } from '@/lib/auth-client';
import { checkProjectAccess } from '@/lib/project-access';
import { selectOptimisticUserName, useStore } from '@/lib/store';
import { isNetworkError } from '@/lib/utils';
import { getAuthErrorInfo } from '@shared/auth-errors';
import { parseHost } from '@shared/domain';
import { clearProjectDeepLinkSearchParameters, parseProjectDeepLink, type ProjectDeepLinkTarget } from '@shared/project-deep-link';
import { PROJECT_ID_PATTERN } from '@shared/project-id';

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 1000 * 60,
			retry: 1,
			refetchOnWindowFocus: false,
		},
	},
	mutationCache: new MutationCache({
		onError: (error) => {
			if (isNetworkError(error)) {
				toast.error('You appear to be offline. Check your connection and try again.');
			}
		},
	}),
});

function LoadingFallback() {
	return (
		<div className="flex h-dvh items-center justify-center bg-bg-primary">
			<motion.div layoutId="global-app-spinner">
				<Spinner size="xl" className="text-text-secondary" />
			</motion.div>
		</div>
	);
}

function isDeletedOrganization(value: unknown): boolean {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	const deletedAt = Reflect.get(value, 'deletedAt');
	return deletedAt instanceof Date || typeof deletedAt === 'string';
}

function hasOrganizationSlug<T extends { slug: string | null }>(organization: T): organization is T & { slug: string } {
	return typeof organization.slug === 'string' && organization.slug.length > 0;
}

function ErrorFallback({ error, resetErrorBoundary }: { error: Error; resetErrorBoundary: () => void }) {
	const [copied, setCopied] = useState(false);
	const copyTimerReference = useRef<ReturnType<typeof setTimeout>>(undefined);

	function handleCopy() {
		void navigator.clipboard
			?.writeText(error.message)
			.then(() => {
				clearTimeout(copyTimerReference.current);
				setCopied(true);
				copyTimerReference.current = setTimeout(() => setCopied(false), 2000);
			})
			.catch(() => {
				// Clipboard API unavailable (HTTP context, iframe restrictions, etc.)
			});
	}

	return (
		<div className="flex h-dvh items-center justify-center bg-bg-primary p-4">
			<div
				className="
					max-w-lg rounded-xl border border-error/50 bg-bg-secondary p-10 shadow-lg
				"
			>
				<div className="mb-3 flex items-center justify-between">
					<h1 className="text-xl font-semibold text-error">Something went wrong</h1>
					<button
						onClick={handleCopy}
						title="Copy error to clipboard"
						className="
							-mr-1.5 cursor-pointer rounded-md p-1.5 text-text-secondary
							transition-colors
							hover:bg-bg-tertiary hover:text-text-primary
						"
					>
						{copied ? <Check className="size-4 text-green-500" /> : <ClipboardCopy className="size-4" />}
					</button>
				</div>
				<div className="mb-8">
					<pre
						className="
							max-h-48 overflow-auto rounded-md bg-bg-tertiary p-5 font-mono
							text-sm/relaxed text-text-secondary
						"
					>
						{error.message}
					</pre>
				</div>
				<button
					onClick={resetErrorBoundary}
					className="
						cursor-pointer rounded-md bg-accent px-5 py-2.5 text-sm font-medium
						text-white transition-colors
						hover:bg-accent-hover
					"
				>
					Try again
				</button>
			</div>
		</div>
	);
}

/**
 * Gate component that verifies a project is accessible before mounting the IDE.
 * Uses React 19 `use()` to suspend until the access check resolves.
 */
function ProjectGate({
	projectId,
	initialProjectDeepLink,
	onInitialProjectDeepLinkHandled,
}: {
	projectId: string;
	initialProjectDeepLink?: ProjectDeepLinkTarget;
	onInitialProjectDeepLinkHandled?: () => void;
}) {
	const accessStatus = use(checkProjectAccess(projectId));

	if (accessStatus === 'forbidden') {
		return <ProjectAccessRestricted />;
	}

	if (accessStatus === 'not-found') {
		return <ProjectNotFound />;
	}

	return (
		<ValidProject
			projectId={projectId}
			initialProjectDeepLink={initialProjectDeepLink}
			onInitialProjectDeepLinkHandled={onInitialProjectDeepLinkHandled}
		/>
	);
}
function ValidProject({
	projectId,
	initialProjectDeepLink,
	onInitialProjectDeepLinkHandled,
}: {
	projectId: string;
	initialProjectDeepLink?: ProjectDeepLinkTarget;
	onInitialProjectDeepLinkHandled?: () => void;
}) {
	return (
		<IDEShell
			projectId={projectId}
			initialProjectDeepLink={initialProjectDeepLink}
			onInitialProjectDeepLinkHandled={onInitialProjectDeepLinkHandled}
		/>
	);
}

/**
 * localStorage key for remembering the last-visited org slug.
 * Used by the `/` redirect to take the user back to their last org.
 */
const LAST_ORG_SLUG_KEY = 'lastOrgSlug';

/**
 * Persist the last-visited org slug/id in localStorage so the root redirect
 * can take the user back to their last org on next visit.
 */
function useRememberOrgSlug(orgIdentifier: string | undefined) {
	useEffect(() => {
		if (orgIdentifier) {
			globalThis.localStorage.setItem(LAST_ORG_SLUG_KEY, orgIdentifier);
		}
	}, [orgIdentifier]);
}

/**
 * Auth gate — simplified flow without session-stored active org:
 *
 * 1. No session -> Login page
 * 2. Session exists -> fetch org list
 * 3. 0 orgs -> redirect to /create-org
 * 4. Has orgs -> URL-based routing
 */
function AuthGate() {
	const { data: session, isPending: sessionPending } = authClient.useSession();
	const { data: organizations, isPending: listPending } = authClient.useListOrganizations();
	const { data: activeOrganization } = authClient.useActiveOrganization();
	const optimisticUserName = useStore(selectOptimisticUserName);
	const optimisticOrganizationNames = useStore((state) => state.optimisticOrganizationNames);
	const setOptimisticUserName = useStore((state) => state.setOptimisticUserName);
	const setOptimisticOrganizationName = useStore((state) => state.setOptimisticOrganizationName);
	const baseVisibleOrganizations = (organizations ?? []).filter(
		(organization) => !isDeletedOrganization(organization) && hasOrganizationSlug(organization),
	);
	const visibleOrganizations = baseVisibleOrganizations.map((organization) => ({
		...organization,
		name: optimisticOrganizationNames[organization.id] ?? organization.name,
	}));
	const visibleActiveOrganization = activeOrganization && !isDeletedOrganization(activeOrganization) ? activeOrganization : undefined;

	useEffect(() => {
		if (optimisticUserName && session?.user.name === optimisticUserName) {
			setOptimisticUserName(undefined);
		}
	}, [optimisticUserName, session?.user.name, setOptimisticUserName]);

	useEffect(() => {
		for (const organization of baseVisibleOrganizations) {
			const optimisticName = optimisticOrganizationNames[organization.id];
			if (optimisticName && organization.name === optimisticName) {
				setOptimisticOrganizationName(organization.id, undefined);
			}
		}
	}, [baseVisibleOrganizations, optimisticOrganizationNames, setOptimisticOrganizationName]);

	// Auto-set the active organization when the session has none
	const autoActivatedReference = useRef(false);
	useEffect(() => {
		if (autoActivatedReference.current) return;
		if (!session || listPending) return;
		if (visibleActiveOrganization) return;
		const firstOrganization = visibleOrganizations[0];
		if (!firstOrganization) return;
		autoActivatedReference.current = true;
		void authClient.organization.setActive({ organizationId: firstOrganization.id });
	}, [session, listPending, visibleActiveOrganization, visibleOrganizations]);

	if (sessionPending) {
		return <LoadingFallback />;
	}

	if (!session) {
		return (
			<Suspense fallback={<LoadingFallback />}>
				<LoginPage />
			</Suspense>
		);
	}

	if (listPending) {
		return <LoadingFallback />;
	}

	const user = {
		name: optimisticUserName ?? session.user.name,
		email: session.user.email,
		image: session.user.image ?? undefined,
		emailVerified: session.user.emailVerified,
	};
	return <AppContent organizations={visibleOrganizations} user={user} activeOrganizationId={visibleActiveOrganization?.id} />;
}

interface OrganizationEntry {
	id: string;
	name: string;
	slug: string;
	plan?: string;
}

interface UserInfo {
	name: string;
	email: string;
	image?: string;
	emailVerified?: boolean;
}
function ProjectRoute() {
	const { projectId } = useParams<{ projectId: string }>();
	const [searchParameters, setSearchParameters] = useSearchParams();
	const initialProjectDeepLink = parseProjectDeepLink(searchParameters);
	const handleInitialProjectDeepLinkHandled = useCallback(() => {
		if (!initialProjectDeepLink) {
			return;
		}

		setSearchParameters(clearProjectDeepLinkSearchParameters(searchParameters), { replace: true });
	}, [initialProjectDeepLink, searchParameters, setSearchParameters]);

	if (!projectId || !PROJECT_ID_PATTERN.test(projectId)) {
		return <NotFoundPage />;
	}

	return (
		<Suspense fallback={<LoadingFallback />}>
			<ProjectGate
				projectId={projectId}
				initialProjectDeepLink={initialProjectDeepLink}
				onInitialProjectDeepLinkHandled={handleInitialProjectDeepLinkHandled}
			/>
		</Suspense>
	);
}

/**
 * Route wrapper for org dashboard. Extracts orgSlug from URL params,
 * resolves the organization, and remembers the last visited org.
 */
function OrgDashboardRoute({ organizations, user }: { organizations: OrganizationEntry[]; user: UserInfo }) {
	const { orgSlug } = useParams<{ orgSlug: string }>();
	const organization = orgSlug ? organizations.find((entry) => entry.slug === orgSlug) : undefined;
	const orgIdentifier = organization?.slug;

	useRememberOrgSlug(orgIdentifier);

	if (!orgSlug || !organization) {
		return <NotFoundPage />;
	}

	return (
		<Suspense fallback={<PageContentSkeleton />}>
			<DashboardPage organizationId={organization.id} organizations={organizations} user={user} />
		</Suspense>
	);
}
function OrgSettingsRoute({ organizations }: { organizations: OrganizationEntry[] }) {
	const { orgSlug } = useParams<{ orgSlug: string }>();
	const organization = orgSlug ? organizations.find((entry) => entry.slug === orgSlug) : undefined;
	const orgIdentifier = organization?.slug;

	useRememberOrgSlug(orgIdentifier);

	if (!orgSlug || !organization) {
		return <NotFoundPage />;
	}

	return (
		<Suspense fallback={<OrganizationManagementSkeleton />}>
			<OrgManagementPage orgSlug={orgSlug} organizationId={organization.id} organizations={organizations} />
		</Suspense>
	);
}

/**
 * Root redirect: / → /org/:slug
 * Priority: 1) session activeOrganizationId  2) localStorage  3) first org
 */
function RootRedirect({ organizations, activeOrganizationId }: { organizations: OrganizationEntry[]; activeOrganizationId?: string }) {
	if (organizations.length === 0) {
		return <Navigate to="/create-org" replace />;
	}

	const activeOrg = activeOrganizationId ? organizations.find((o) => o.id === activeOrganizationId) : undefined;
	const lastSlug = globalThis.localStorage.getItem(LAST_ORG_SLUG_KEY);
	const lastOrg = lastSlug ? organizations.find((o) => o.slug === lastSlug) : undefined;
	const targetOrg = activeOrg ?? lastOrg ?? organizations[0];
	if (!targetOrg) {
		return <Navigate to="/create-org" replace />;
	}
	return <Navigate to={`/org/${targetOrg.slug}`} replace />;
}

/**
 * Layout route wrapper for `/settings/*`.
 *
 * Renders the eagerly-loaded SettingsLayout as a persistent shell
 * and uses `<Outlet />` for nested child routes. This means the
 * sidebar and header never unmount when switching between settings
 * sub-pages — only the content area swaps.
 */
function SettingsRoute() {
	const { pathname } = useLocation();

	return (
		<SettingsLayout activePath={pathname}>
			<Suspense fallback={<SettingsContentSkeleton />}>
				<Outlet />
			</Suspense>
		</SettingsLayout>
	);
}

function AppContent({
	organizations,
	user,
	activeOrganizationId,
}: {
	organizations: OrganizationEntry[];
	user: UserInfo;
	activeOrganizationId?: string;
}) {
	const hostType = useMemo(() => parseHost(globalThis.location.host).type, []);

	// Sync user preferences from server → store → localStorage
	useUserPreferences();

	useTheme();

	// Sync editor font CSS variable with user preference
	useEditorFont();

	if (hostType !== 'app') {
		return <NotFoundPage />;
	}

	// 0 orgs — force user to create an org before doing anything else.
	// Only the /create-org and /p/:projectId routes are accessible.
	if (organizations.length === 0) {
		return (
			<Routes>
				<Route path="/p/:projectId" element={<ProjectRoute />} />
				<Route
					path="/create-org"
					element={
						<Suspense fallback={<PageContentSkeleton />}>
							<DashboardPage organizationId="" organizations={organizations} isCreateOrgMode user={user} />
						</Suspense>
					}
				/>
				<Route path="*" element={<Navigate to="/create-org" replace />} />
			</Routes>
		);
	}

	return (
		<Routes>
			<Route path="/p/:projectId" element={<ProjectRoute />} />
			<Route
				path="/create-org"
				element={
					<Suspense fallback={<PageContentSkeleton />}>
						<DashboardPage organizationId="" organizations={organizations} isCreateOrgMode user={user} />
					</Suspense>
				}
			/>
			<Route path="/settings" element={<SettingsRoute />}>
				<Route index element={<Navigate to="profile" replace />} />
				<Route path="profile" element={<ProfilePage user={user} />} />
				<Route path="account" element={<AccountPage />} />
			</Route>
			<Route path="/org/:orgSlug/settings" element={<OrgSettingsRoute organizations={organizations} />} />
			<Route path="/org/:orgSlug" element={<OrgDashboardRoute organizations={organizations} user={user} />} />
			<Route path="/" element={<RootRedirect organizations={organizations} activeOrganizationId={activeOrganizationId} />} />
			<Route path="*" element={<NotFoundPage />} />
		</Routes>
	);
}

/**
 * Reads `?error=<code>` from the URL (set by Better Auth on OAuth failures)
 * and surfaces a user-friendly toast. Clears the param afterward so the
 * error is not re-shown on page refresh.
 *
 * Only consumes `?error=` values that map to a known auth error code
 * (see `shared/auth-errors.ts`), so unrelated query params are left alone.
 *
 * Note: Better Auth's `errorURL` is a static config (`/`), so all OAuth
 * errors — including account-linking failures — redirect here.
 */
function AuthErrorHandler() {
	const [searchParameters, setSearchParameters] = useSearchParams();
	const errorCode = searchParameters.get('error') ?? undefined;

	useEffect(() => {
		if (!errorCode) return;

		const errorInfo = getAuthErrorInfo(errorCode);
		if (!errorInfo) return;

		toast.error(errorInfo.message, { title: errorInfo.title });

		// Remove the error param from the URL without a navigation
		setSearchParameters(
			(previous) => {
				const next = new URLSearchParams(previous);
				next.delete('error');
				return next;
			},
			{ replace: true },
		);
	}, [errorCode, setSearchParameters]);

	return <></>;
}

function PwaUpdateHandler(): React.JSX.Element {
	usePwaUpdate();
	return <></>;
}

export function App() {
	return (
		<ErrorBoundary fallback={ErrorFallback}>
			<QueryClientProvider client={queryClient}>
				<AppDocumentMetadata />
				<OfflineBanner />
				<AuthErrorHandler />
				<AuthGate />
				<AppearanceModal />
				<GlobalDialogBackdrop />
				<PwaUpdateHandler />
				<Toaster />
			</QueryClientProvider>
		</ErrorBoundary>
	);
}
