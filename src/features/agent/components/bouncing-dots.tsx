import { cn } from '@/lib/utils';

export function BouncingDots({ className }: { className?: string }) {
	return (
		<span className={cn('inline-flex items-end gap-[2px]', className)} aria-label="Processing speech">
			{[0, 1, 2].map((index) => (
				<span
					key={index}
					className="size-[3px] rounded-full bg-current"
					// CSS keeps the loop independent of Motion's inherited initial={false}.
					style={{
						opacity: 0.2,
						animation: 'speech-dot 1.2s ease-in-out infinite',
						animationDelay: `${index * 0.2}s`,
					}}
				/>
			))}
		</span>
	);
}
