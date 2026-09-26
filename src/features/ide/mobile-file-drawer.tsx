import { Dialog } from '@base-ui/react/dialog';
import { AnimatePresence, motion } from 'motion/react';

import { useDialogStackPresence } from '@/components/ui/dialog-stack';
import { useDeferredOpen } from '@/hooks/use-deferred-open';
import { slideLeftVariants, springCritical } from '@/lib/motion-config';
import { useStore } from '@/lib/store';

import type { ReactNode } from 'react';

interface MobileFileDrawerProperties {
	children: ReactNode;
}

export function MobileFileDrawer({ children }: MobileFileDrawerProperties) {
	const mobileFileTreeOpen = useStore((state) => state.mobileFileTreeOpen);
	const toggleMobileFileTree = useStore((state) => state.toggleMobileFileTree);
	const { dialogOpen, show, onExitComplete } = useDeferredOpen(mobileFileTreeOpen);
	const handleOpenChange = (nextOpen: boolean) => {
		if (nextOpen || !mobileFileTreeOpen) {
			return;
		}

		toggleMobileFileTree();
	};
	useDialogStackPresence(dialogOpen, () => handleOpenChange(false));

	return (
		<Dialog.Root open={dialogOpen} onOpenChange={handleOpenChange}>
			{dialogOpen && (
				<Dialog.Portal keepMounted>
					<AnimatePresence onExitComplete={onExitComplete}>
						{show && (
							<Dialog.Popup
								render={
									<motion.div variants={slideLeftVariants} initial="hidden" animate="visible" exit="exit" transition={springCritical} />
								}
								className="
									fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-bg-secondary
									shadow-xl
								"
							>
								<Dialog.Title className="sr-only">File Explorer</Dialog.Title>
								<Dialog.Description className="sr-only">Browse and select project files</Dialog.Description>
								{children}
							</Dialog.Popup>
						)}
					</AnimatePresence>
				</Dialog.Portal>
			)}
		</Dialog.Root>
	);
}
