import { Bot, Code, Eye, FlaskConical, GitBranch } from 'lucide-react';
import { motion } from 'motion/react';

import { BorderBeam } from '@/components/ui/border-beam';
import { springSnappy } from '@/lib/motion-config';
import { selectIsProcessing, useStore } from '@/lib/store';
import { cn } from '@/lib/utils';

import type { MobilePanel } from '@/lib/store';

function useMobileTabAction() {
	const activeMobilePanel = useStore((state) => state.activeMobilePanel);
	const setActiveMobilePanel = useStore((state) => state.setActiveMobilePanel);
	const toggleMobileFileTree = useStore((state) => state.toggleMobileFileTree);

	return (panel: MobilePanel) => {
		if (panel === 'editor' && activeMobilePanel === 'editor') {
			toggleMobileFileTree();
		} else {
			setActiveMobilePanel(panel);
		}
	};
}

const TABS: Array<{ panel: MobilePanel; label: string; icon: typeof Code }> = [
	{ panel: 'editor', label: 'Editor', icon: Code },
	{ panel: 'preview', label: 'Preview', icon: Eye },
	{ panel: 'git', label: 'Git', icon: GitBranch },
	{ panel: 'tests', label: 'Tests', icon: FlaskConical },
	{ panel: 'agent', label: 'Agent', icon: Bot },
];

export function MobileTabBar() {
	const activeMobilePanel = useStore((state) => state.activeMobilePanel);
	const handleTabPress = useMobileTabAction();
	const isProcessing = useStore(selectIsProcessing);

	return (
		<nav
			className="
				flex h-12 shrink-0 items-stretch border-t border-border bg-bg-secondary
				safe-area-b
			"
		>
			{TABS.map(({ panel, label, icon: Icon }) => {
				const isActive = activeMobilePanel === panel;
				const showProcessingIndicator = panel === 'agent' && isProcessing && !isActive;

				return (
					<button
						key={panel}
						type="button"
						onClick={() => handleTabPress(panel)}
						className={cn(
							`
								relative flex flex-1 cursor-pointer flex-col items-center justify-center
								gap-0.5 transition-colors
							`,
							isActive ? 'text-accent' : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary',
						)}
						aria-label={label}
						aria-current={isActive ? 'page' : undefined}
					>
						{isActive && (
							<motion.span layoutId="mobile-tab-indicator" className="absolute inset-0 bg-accent/10" transition={springSnappy} />
						)}
						<Icon className="relative size-5" />
						<span className="relative text-3xs font-medium">{label}</span>
						{showProcessingIndicator && <BorderBeam duration={1.5} />}
					</button>
				);
			})}
		</nav>
	);
}
