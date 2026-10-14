import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { Tooltip } from '@/components/ui/tooltip';
import { createApiClient } from '@/lib/api/create-client';
import { throwApiError } from '@/lib/api-error';
import { isMessageFromPreview } from '@/lib/preview-origin';
import { cn } from '@/lib/utils';
import { runtimeStatusSchema } from '@shared/runtime-status';

import type { RuntimeBackend, RuntimeReason } from '@shared/runtime-status';

const REASONS: Record<RuntimeReason, string> = {
	'simple-project': 'Simple project',
	'project-requirements': 'Project requires native Vite',
	'explicit-choice': 'Project runtime setting',
	'resource-limit': 'Worker compilation limit reached',
};

export function RuntimeStatusIndicator({
	projectId,
	previewOrigin,
	iframeReference,
}: {
	projectId: string;
	previewOrigin: string | undefined;
	iframeReference: React.RefObject<HTMLIFrameElement | null>;
}) {
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
		preview &&
		preview.generation >= loadedGeneration &&
		(preview?.phase === 'starting' ||
			preview?.phase === 'switching' ||
			(loadedBackend && preview?.phase === 'ready' && loadedBackend !== preview.backend));
	const backend = loadedBackend ?? preview?.backend;
	const target = preview?.target;
	const name = (value: RuntimeBackend | undefined) => (value === 'container' ? 'Container' : value === 'worker' ? 'Worker' : undefined);
	const label =
		isError && !preview
			? 'Runtime unavailable'
			: pending
				? `${name(backend) && backend !== target ? `${name(backend)} → ` : ''}${name(target) ?? 'Runtime'} starting`
				: `${name(backend) ?? 'Runtime'}${preview?.phase === 'sleeping' ? ' sleeping' : preview?.phase === 'error' ? ' error' : backend ? '' : ' idle'}`;
	const detail = preview?.reason ? REASONS[preview.reason] : 'Preview runtime';
	const build = status?.build;
	return (
		<Tooltip content={`${detail}${build?.backend ? ` · Build: ${name(build.backend)} (${build.phase})` : ''}`}>
			<span
				role="status"
				aria-live="polite"
				aria-label={label}
				className={cn(
					'truncate text-[10px] text-text-secondary',
					pending && 'text-amber-500',
					preview?.phase === 'error' && 'text-red-500',
				)}
			>
				{label}
			</span>
		</Tooltip>
	);
}
