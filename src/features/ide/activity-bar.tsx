import { Files, FlaskConical, GitBranch } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';

import { Tooltip } from '@/components/ui/tooltip';
import { springSnappy } from '@/lib/motion-config';
import { useStore, selectActiveSidebarView, selectGitChangedFileCount, type SidebarView } from '@/lib/store';
import { cn } from '@/lib/utils';

interface ActivityBarProperties {
	className?: string;
}

interface ActivityBarItemProperties {
	icon: React.ReactNode;
	label: string;
	view: SidebarView;
	activeView: SidebarView;
	badge?: number;
	onSelect: (view: SidebarView) => void;
}

function ActivityBarItem({ icon, label, view, activeView, badge, onSelect }: ActivityBarItemProperties) {
	const isActive = activeView === view;

	return (
		<Tooltip content={label} side="right" delayDuration={300}>
			<button
				type="button"
				onClick={() => onSelect(view)}
				className={cn(
					'relative flex size-10 cursor-pointer items-center justify-center',
					'border-l-2 border-transparent transition-colors',
					isActive ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary',
				)}
			>
				{isActive && (
					<motion.span
						layoutId="activity-bar-indicator"
						className="absolute inset-y-0 left-[-2px] w-0.5 bg-accent"
						transition={springSnappy}
					/>
				)}
				{icon}
				<AnimatePresence>
					{badge !== undefined && badge > 0 && (
						<motion.span
							initial={{ scale: 0 }}
							animate={{ scale: 1 }}
							exit={{ scale: 0 }}
							transition={springSnappy}
							className={cn(
								'absolute top-1 right-1 flex size-4 items-center justify-center',
								'rounded-full bg-accent text-[10px] leading-none font-bold text-white',
							)}
						>
							{badge > 99 ? '99+' : badge}
						</motion.span>
					)}
				</AnimatePresence>
			</button>
		</Tooltip>
	);
}

export function ActivityBar({ className }: ActivityBarProperties) {
	const activeSidebarView = useStore(selectActiveSidebarView);
	const setActiveSidebarView = useStore((state) => state.setActiveSidebarView);
	const gitChangedCount = useStore(selectGitChangedFileCount);

	return (
		<div
			className={cn(
				`
					flex w-10 shrink-0 flex-col items-center border-r border-border
					bg-bg-secondary pt-1
				`,
				className,
			)}
		>
			<ActivityBarItem
				icon={<Files className="size-5" />}
				label="Explorer"
				view="explorer"
				activeView={activeSidebarView}
				onSelect={setActiveSidebarView}
			/>
			<ActivityBarItem
				icon={<GitBranch className="size-5" />}
				label="Git"
				view="git"
				activeView={activeSidebarView}
				badge={gitChangedCount}
				onSelect={setActiveSidebarView}
			/>
			<ActivityBarItem
				icon={<FlaskConical className="size-5" />}
				label="Tests"
				view="tests"
				activeView={activeSidebarView}
				onSelect={setActiveSidebarView}
			/>
		</div>
	);
}
