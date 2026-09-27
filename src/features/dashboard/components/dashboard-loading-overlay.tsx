import { motion } from 'motion/react';

import { Spinner } from '@/components/ui/spinner';

function LoadingOverlay({ message }: { message: string }) {
	return (
		<div
			className="
				fixed inset-0 z-50 flex items-center justify-center bg-bg-primary/80
				backdrop-blur-sm
			"
		>
			<div className="flex flex-col items-center gap-4">
				<motion.div layoutId="global-app-spinner">
					<Spinner size="lg" />
				</motion.div>
				<p className="text-sm text-text-secondary">{message}</p>
			</div>
		</div>
	);
}

export { LoadingOverlay };
