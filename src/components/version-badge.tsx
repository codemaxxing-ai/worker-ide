import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';

import { Tooltip, TooltipProvider } from '@/components/ui/tooltip';
import { createRootApiClient } from '@/lib/api-client';
import { cn } from '@/lib/utils';
const TRUNCATED_LENGTH = 7;
const GIT_SHA = __APP_VERSION__;

interface CloudflareVersionMetadata {
	id: string;
	tag: string;
	timestamp: string;
}

function useCloudflareVersion(): CloudflareVersionMetadata | undefined {
	const query = useQuery({
		queryKey: ['cf-version'],
		queryFn: async () => {
			const response = await createRootApiClient().version.$get({});
			if (!response.ok) return;
			const data: CloudflareVersionMetadata = await response.json();
			return data.id ? data : undefined;
		},
		staleTime: 1000 * 60 * 10,
		retry: false,
	});

	return query.data ?? undefined;
}

interface VersionBadgeProperties {
	className?: string;
	/**
	 * Whether to wrap in its own TooltipProvider.
	 * Set to `false` when rendered inside a parent that already provides one.
	 */
	withProvider?: boolean;
}

export function VersionBadge({ className, withProvider = true }: VersionBadgeProperties) {
	const cloudflareVersion = useCloudflareVersion();

	const truncated = GIT_SHA.slice(0, TRUNCATED_LENGTH);

	const tooltipContent = cloudflareVersion ? `${GIT_SHA}\nDeploy: ${cloudflareVersion.id.slice(0, TRUNCATED_LENGTH)}` : GIT_SHA;

	const handleClick = useCallback(() => {
		void navigator.clipboard.writeText(GIT_SHA).catch(() => {
			// Clipboard API unavailable (HTTP context, iframe restrictions, etc.)
		});
	}, []);

	const badge = (
		<Tooltip content={tooltipContent} side="top">
			<button
				type="button"
				onClick={handleClick}
				className={cn(
					`
						cursor-pointer rounded-sm font-mono text-xs text-text-secondary
						transition-colors
					`,
					`
						hover:text-accent
						focus-visible:text-accent focus-visible:outline-none
					`,
					className,
				)}
				aria-label={`Version ${GIT_SHA}. Click to copy.`}
			>
				{truncated}
			</button>
		</Tooltip>
	);

	if (withProvider) {
		return <TooltipProvider>{badge}</TooltipProvider>;
	}

	return badge;
}
