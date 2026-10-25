import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

import type { ComponentProps } from 'react';

const spinnerVariants = cva('text-current', {
	variants: {
		size: {
			xs: 'size-3',
			sm: 'size-4',
			md: 'size-6',
			lg: 'size-8',
			xl: 'size-12',
		},
	},
	defaultVariants: {
		size: 'md',
	},
});

export interface SpinnerProperties extends ComponentProps<'svg'>, VariantProps<typeof spinnerVariants> {
	className?: string;
}

export function Spinner({ size, className, style, ...properties }: SpinnerProperties) {
	// CSS keeps the loop independent of Motion's inherited initial={false}.
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={cn(spinnerVariants({ size }), className)}
			style={{ animation: 'spin 6s linear infinite', transformOrigin: 'center', ...style }}
			role="status"
			aria-label="Loading"
			{...properties}
		>
			<title>Loading...</title>
			<path
				style={{ animation: 'spinner-dash 3.3s cubic-bezier(0.4, 0, 0.2, 1) infinite' }}
				d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"
				pathLength="100"
				strokeWidth="2.5"
				strokeDasharray="90 10"
				strokeDashoffset="0"
			/>
		</svg>
	);
}
