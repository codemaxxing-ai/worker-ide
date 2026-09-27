import { Copy, Hexagon, Search, TriangleAlert } from 'lucide-react';
import { useRef } from 'react';

import { Button } from '@/components/ui/button';
import { Modal, ModalBody, ModalFooter } from '@/components/ui/modal';
import { cn } from '@/lib/utils';

import type { ProjectTemplateMeta } from '@shared/types';

/**
 * Maps Lucide icon names (strings from template metadata) to components.
 * Add entries here when adding new templates with different icons.
 */
const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
	Hexagon,
	Search,
};

function TemplateIcon({ name, className }: { name: string; className?: string }) {
	const IconComponent = ICON_MAP[name];
	if (!IconComponent) return <Search className={className} />;
	return <IconComponent className={className} />;
}

function TemplateCard({
	template,
	onSelect,
	disabled,
}: {
	template: ProjectTemplateMeta;
	onSelect: (templateId: string) => void;
	disabled: boolean;
}) {
	return (
		<button
			data-local-focus="true"
			onClick={() => onSelect(template.id)}
			disabled={disabled}
			className={cn(
				`
					group flex h-28 w-full cursor-pointer flex-col items-center gap-2
					rounded-lg border border-border p-4
				`,
				'bg-bg-secondary/60 backdrop-blur-sm transition-all',
				'hover:border-accent/50 hover:bg-bg-secondary/80',
				`
					focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2
					focus-visible:ring-offset-bg-primary focus-visible:outline-none
				`,
				'disabled:pointer-events-none disabled:opacity-50',
			)}
		>
			<div
				className={cn(
					'flex size-8 items-center justify-center rounded-md',
					'bg-accent/10 text-accent transition-colors',
					'group-hover:bg-accent/20',
				)}
			>
				<TemplateIcon name={template.icon} className="size-4" />
			</div>
			<span className="line-clamp-2 text-center text-xs font-medium text-text-primary">{template.name}</span>
		</button>
	);
}

function TemplateCardSkeleton() {
	return (
		<div className={cn('flex flex-col items-center gap-2 rounded-lg border border-border p-4', 'bg-bg-secondary/40 backdrop-blur-sm')}>
			<div className="size-8 animate-pulse rounded-md bg-bg-tertiary" />
			<div className="h-4 w-16 animate-pulse rounded-sm bg-bg-tertiary" />
		</div>
	);
}

function TemplateDetailModal({
	template,
	open,
	onOpenChange,
	onCreateProject,
	isLoading,
	projectLimitReached,
}: {
	template: ProjectTemplateMeta | undefined;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreateProject: (templateId: string) => void;
	isLoading: boolean;
	projectLimitReached: boolean;
}) {
	if (!template) return;

	return (
		<Modal open={open} onOpenChange={onOpenChange} title={template.name}>
			<ModalBody>
				<div className="flex items-start gap-4">
					<div className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg', 'bg-accent/10 text-accent')}>
						<TemplateIcon name={template.icon} className="size-5" />
					</div>
					<p className="text-sm/relaxed text-text-secondary">{template.description}</p>
				</div>
				{projectLimitReached && (
					<div
						className="
							mt-3 flex items-center gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs
							text-warning
						"
					>
						<TriangleAlert className="size-3.5 shrink-0" />
						<span>You have exceeded the maximum number of projects that you can create.</span>
					</div>
				)}
			</ModalBody>
			<ModalFooter>
				<Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
					Cancel
				</Button>
				<Button size="sm" onClick={() => onCreateProject(template.id)} disabled={isLoading || projectLimitReached} isLoading={isLoading}>
					Create Project
				</Button>
			</ModalFooter>
		</Modal>
	);
}

function CloneCard({ onSelect, disabled }: { onSelect: () => void; disabled: boolean }) {
	return (
		<button
			data-local-focus="true"
			onClick={onSelect}
			disabled={disabled}
			className={cn(
				`
					group flex h-28 w-full cursor-pointer flex-col items-center gap-2
					rounded-lg border border-border p-4
				`,
				'bg-bg-secondary/60 backdrop-blur-sm transition-all',
				'hover:border-accent/50 hover:bg-bg-secondary/80',
				`
					focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2
					focus-visible:ring-offset-bg-primary focus-visible:outline-none
				`,
				'disabled:pointer-events-none disabled:opacity-50',
			)}
		>
			<div
				className={cn(
					'flex size-8 items-center justify-center rounded-md',
					'bg-accent/10 text-accent transition-colors',
					'group-hover:bg-accent/20',
				)}
			>
				<Copy className="size-4" />
			</div>
			<span className="line-clamp-2 text-center text-xs font-medium text-text-primary">Clone a project</span>
		</button>
	);
}

function CloneModal({
	open,
	onOpenChange,
	cloneInput,
	onCloneInputChange,
	parsedProjectId,
	onClone,
	cloneError,
	isLoading,
	projectLimitReached,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	cloneInput: string;
	onCloneInputChange: (value: string) => void;
	parsedProjectId: string | undefined;
	onClone: () => void;
	cloneError: string | undefined;
	isLoading: boolean;
	projectLimitReached: boolean;
}) {
	const inputReference = useRef<HTMLInputElement>(null);

	return (
		<Modal open={open} onOpenChange={onOpenChange} title="Clone a project">
			<ModalBody>
				<p className="mb-3 text-sm text-text-secondary">Paste a project URL or ID to create a copy.</p>
				<div className="relative">
					<Copy
						className="
							pointer-events-none absolute top-1/2 left-3 z-10 size-3.5
							-translate-y-1/2 text-text-secondary
						"
					/>
					<input
						ref={inputReference}
						type="text"
						value={cloneInput}
						onChange={(event) => onCloneInputChange(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === 'Enter' && parsedProjectId) {
								onClone();
							}
						}}
						placeholder="Project URL or ID"
						disabled={isLoading}
						className={cn(
							'h-9 w-full rounded-md border bg-bg-secondary/60 pr-3 pl-9',
							`
								text-xs text-text-primary
								placeholder:text-text-secondary/50
							`,
							'backdrop-blur-sm transition-colors',
							`
								focus-within:border-accent
								focus:outline-none
							`,
							cloneError ? 'border-error/50' : 'border-border',
						)}
					/>
				</div>
				{cloneError && <p className="mt-2 text-xs text-error">{cloneError}</p>}
				{projectLimitReached && (
					<div
						className="
							mt-3 flex items-center gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs
							text-warning
						"
					>
						<TriangleAlert className="size-3.5 shrink-0" />
						<span>You have exceeded the maximum number of projects that you can create.</span>
					</div>
				)}
			</ModalBody>
			<ModalFooter>
				<Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
					Cancel
				</Button>
				<Button size="sm" onClick={onClone} disabled={isLoading || !parsedProjectId || projectLimitReached} isLoading={isLoading}>
					Clone
				</Button>
			</ModalFooter>
		</Modal>
	);
}

export { CloneCard, CloneModal, TemplateCard, TemplateCardSkeleton, TemplateDetailModal };
