import { Separator } from 'react-resizable-panels';

import { cn } from '@/lib/utils';

interface PanelDividerProperties {
	orientation: 'horizontal' | 'vertical';
}

export function PanelDivider({ orientation }: PanelDividerProperties) {
	const isHorizontal = orientation === 'horizontal';

	return (
		<Separator className={cn('group relative', isHorizontal ? 'w-0 cursor-col-resize' : 'h-0 cursor-row-resize')}>
			<div
				className={cn(
					'absolute z-10 bg-border-solid',
					'transition-[width,height,background-color] duration-100 ease-out',
					isHorizontal
						? `
							top-0 left-1/2 h-full w-px -translate-x-1/2 cursor-col-resize
							group-data-[separator=active]:w-1 group-data-[separator=active]:bg-accent
							group-data-[separator=hover]:w-1 group-data-[separator=hover]:bg-accent
						`
						: `
							top-1/2 left-0 h-px w-full -translate-y-1/2 cursor-row-resize
							group-data-[separator=active]:h-1 group-data-[separator=active]:bg-accent
							group-data-[separator=hover]:h-1 group-data-[separator=hover]:bg-accent
						`,
				)}
			/>
		</Separator>
	);
}
