import { cn } from '@/lib/utils';

import type { CSSProperties } from 'react';

const BAR_COUNT = 5;

interface LoadingBarStyle extends CSSProperties {
	'--loading-bar-height': string;
	'--loading-bar-peak-height': string;
}

interface LoadingBarsProperties {
	className?: string;
}

export function LoadingBars({ className }: LoadingBarsProperties) {
	return (
		<div className={cn('flex h-7 items-end gap-[3px]', className)} role="status" aria-label="Loading">
			{Array.from({ length: BAR_COUNT }, (_, index) => {
				// CSS keeps the loop independent of Motion's inherited initial={false}.
				const style = {
					'--loading-bar-height': `${8 + index * 3}px`,
					'--loading-bar-peak-height': `${16 + index * 2}px`,
					height: 'var(--loading-bar-height)',
					opacity: 0.3,
					animation: 'loading-bar 1s ease-in-out infinite',
					animationDelay: `${index * 0.12}s`,
				} satisfies LoadingBarStyle;

				return <div key={index} className="w-[3px] rounded-full bg-accent" style={style} />;
			})}
			<span className="sr-only">Loading...</span>
		</div>
	);
}
