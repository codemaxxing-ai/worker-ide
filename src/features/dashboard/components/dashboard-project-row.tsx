import { getProjectUrl } from '@/lib/preview-origin';
import { cn, formatRelativeTime } from '@/lib/utils';

import type { OrgProject } from '@/lib/api-client';

function ProjectRow({ project }: { project: OrgProject }) {
	return (
		<a
			href={getProjectUrl(project.id)}
			className={cn(
				`
					group/row flex items-center justify-between px-3 py-2 transition-colors
					focus-visible:outline-none
				`,
				`
					text-text-secondary
					hover:bg-bg-tertiary/60 hover:text-text-primary
				`,
			)}
		>
			<span className="truncate text-xs">{project.name || project.id.slice(0, 12)}</span>
			<span className="ml-3 shrink-0 text-xs text-text-secondary/60">
				{formatRelativeTime(new Date(project.lastActivityAt ?? project.updatedAt).getTime())}
			</span>
		</a>
	);
}

export { ProjectRow };
