import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CloudLightning, Container } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/toast-store';
import { Tooltip } from '@/components/ui/tooltip';
import { createApiClient } from '@/lib/api/create-client';
import { throwApiError } from '@/lib/api-error';
import { isMessageFromPreview } from '@/lib/preview-origin';
import { cn } from '@/lib/utils';
import { runtimeStatusSchema } from '@shared/runtime-status';

import type { RuntimeBackend, RuntimeReason } from '@shared/runtime-status';

const REASONS: Record<RuntimeReason, string> = {
	'simple-project': 'Automatic',
	'project-requirements': 'Project requires native Vite',
	'explicit-choice': 'Container selected',
	'resource-limit': 'Worker compilation limit reached',
};

export function RuntimeStatusIndicator({
	projectId,
	previewOrigin,
	iframeReference,
}: {
	projectId: string;
	previewOrigin: string | undefined;
	iframeReference: React.RefObject<HTMLIFrameElement | null | undefined>;
}) {
	const queryClient = useQueryClient();
	const switchRuntime = useMutation({
		mutationFn: async () => {
			const response = await createApiClient(projectId).runtime['switch-to-container'].$post({});
			if (!response.ok) await throwApiError(response, 'Failed to start container');
			return response.json();
		},
		onSuccess: (incoming) =>
			queryClient.setQueryData(['runtime-status', projectId], (previous: unknown) => {
				const parsed = runtimeStatusSchema.safeParse(previous);
				return parsed.success && parsed.data.revision > incoming.revision ? previous : incoming;
			}),
		onError: (error) => toast.error(error.message),
		onSettled: () => queryClient.invalidateQueries({ queryKey: ['runtime-status', projectId] }),
	});
	const [loadedRuntime, setLoadedRuntime] = useState<{ backend: RuntimeBackend; generation: number }>();
	const loadedBackend = loadedRuntime?.backend;
	const loadedGeneration = loadedRuntime?.generation ?? 0;
	const latestGeneration = useRef(0);
	const requestedBackend = useRef<RuntimeBackend | undefined>(undefined);
	const { data: status, isError } = useQuery({
		queryKey: ['runtime-status', projectId],
		queryFn: async () => {
			const response = await createApiClient(projectId)['runtime-status'].$get({});
			if (!response.ok) await throwApiError(response, 'Failed to read runtime status');
			const incoming = await response.json();
			return incoming;
		},
		refetchOnWindowFocus: true,
		structuralSharing: (previous, incoming) => {
			const parsed = runtimeStatusSchema.safeParse(previous);
			const next = runtimeStatusSchema.parse(incoming);
			return parsed.success && parsed.data.revision > next.revision ? previous : incoming;
		},
	});
	useEffect(() => {
		const receive = (event: MessageEvent) => {
			if (!isMessageFromPreview(event)) return;
			const data: unknown = event.data;
			if (!data || typeof data !== 'object' || !('type' in data) || data.type !== '__preview-runtime-ready' || !('backend' in data)) return;
			if (data.backend !== 'worker' && data.backend !== 'container') return;
			if (
				!('generation' in data) ||
				typeof data.generation !== 'number' ||
				!Number.isSafeInteger(data.generation) ||
				data.generation < latestGeneration.current
			)
				return;
			latestGeneration.current = data.generation;
			requestedBackend.current = undefined;
			setLoadedRuntime({ backend: data.backend, generation: data.generation });
		};
		globalThis.addEventListener('message', receive);
		return () => globalThis.removeEventListener('message', receive);
	}, []);
	useEffect(() => {
		const preview = status?.preview;
		if (
			!loadedBackend ||
			!preview ||
			preview.generation < loadedGeneration ||
			preview?.phase !== 'ready' ||
			!preview.backend ||
			loadedBackend === preview.backend ||
			requestedBackend.current === preview.backend ||
			!previewOrigin
		)
			return;
		const window = iframeReference.current?.contentWindow;
		if (!window) return;
		requestedBackend.current = preview.backend;
		window.postMessage({ type: '__preview-runtime-switch', backend: preview.backend }, previewOrigin);
	}, [status, loadedBackend, loadedGeneration, previewOrigin, iframeReference]);
	const preview = status?.preview;
	const pending =
		switchRuntime.isPending ||
		Boolean(
			preview &&
			preview.generation >= loadedGeneration &&
			(preview?.phase === 'starting' ||
				preview?.phase === 'switching' ||
				(loadedBackend && preview?.phase === 'ready' && loadedBackend !== preview.backend)),
		);
	const backend = loadedBackend ?? preview?.backend;
	const target = preview?.target;
	const name = (value: RuntimeBackend | undefined) => (value === 'container' ? 'Container' : value === 'worker' ? 'Worker' : undefined);
	const label =
		isError && !preview
			? 'Runtime unavailable'
			: pending
				? `${name(backend) && backend !== target ? `${name(backend)} → ` : ''}${name(target) ?? 'Runtime'} starting`
				: `${name(backend) ?? 'Runtime'}${preview?.phase === 'sleeping' ? ' sleeping' : preview?.phase === 'blocked' ? ' container limit reached' : preview?.phase === 'error' ? ' error' : backend ? '' : ' idle'}`;
	const detail = preview?.reason ? REASONS[preview.reason] : 'Preview runtime';
	const build = status?.build;
	const failed = preview?.phase === 'error' || preview?.phase === 'blocked';
	const capacity = preview?.capacity;
	const tooltip = `${label} · ${detail}${capacity ? ` · Containers: ${capacity.currentRunningContainers}/${capacity.maxRunningContainers}` : ''}${build?.backend ? ` · Build: ${name(build.backend)} (${build.phase})` : ''}`;
	const RuntimeIcon = backend === 'container' ? Container : CloudLightning;
	return (
		<DropdownMenu>
			<Tooltip content={tooltip}>
				<span role="status" aria-live="polite" aria-label={label}>
					<DropdownMenuTrigger disabled={pending}>
						<button
							id="preview-runtime-control"
							type="button"
							aria-label={`Runtime: ${label}`}
							aria-busy={pending}
							className={cn(
								`
									relative flex size-7 items-center justify-center rounded-sm
									text-text-secondary
									hover:bg-bg-tertiary
									focus-visible:outline-2 focus-visible:outline-accent
								`,
								pending && 'text-amber-500',
								failed && 'text-red-500',
							)}
						>
							<RuntimeIcon aria-hidden="true" className="size-4" />
							{failed && <CircleAlert aria-hidden="true" className="absolute -right-0.5 -bottom-0.5 size-2.5" />}
						</button>
					</DropdownMenuTrigger>
				</span>
			</Tooltip>
			<DropdownMenuContent>
				<DropdownMenuLabel>{label}</DropdownMenuLabel>
				{capacity && (
					<DropdownMenuLabel>
						Containers: {capacity.currentRunningContainers}/{capacity.maxRunningContainers}
					</DropdownMenuLabel>
				)}
				{(backend !== 'container' || failed || preview?.phase === 'sleeping') && (
					<DropdownMenuItem disabled={pending} onSelect={() => switchRuntime.mutate()}>
						<Container aria-hidden="true" className="size-4" />
						{failed || preview?.phase === 'sleeping' ? 'Retry container' : 'Switch to container'}
					</DropdownMenuItem>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
