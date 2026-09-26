import { AlertCircle, Bot, Clock, FastForward, HelpCircle, RefreshCw } from 'lucide-react';

import { cn } from '@/lib/utils';

import { AI_SUGGESTIONS } from '../helpers';

import type { AgentMode } from '@shared/types';

export function WelcomeScreen({
	onSuggestionClick,
	onModeChange,
}: {
	onSuggestionClick: (prompt: string) => void;
	onModeChange: (mode: AgentMode) => void;
}) {
	return (
		<div className="flex flex-col items-center justify-center py-8 text-center">
			<div className="mb-3 text-accent opacity-70">
				<Bot className="size-8" />
			</div>
			<p className="max-w-[250px] text-sm/relaxed text-text-secondary">
				Ask me to help with your code. I can read, create and edit files in your project.
			</p>
			<div className="mt-4 flex flex-wrap justify-center gap-2">
				{AI_SUGGESTIONS.map((suggestion) => (
					<button
						key={suggestion.label}
						onClick={() => {
							onModeChange(suggestion.mode);
							onSuggestionClick(suggestion.prompt);
						}}
						className={cn(
							`
								cursor-pointer rounded-full border border-border bg-bg-tertiary px-3
								py-1.5 text-xs
							`,
							'text-text-secondary transition-colors',
							'hover:border-text-secondary hover:text-text-primary',
						)}
					>
						{suggestion.label}
					</button>
				))}
			</div>
		</div>
	);
}

export function UserQuestionPrompt({
	question,
	options,
	onOptionClick,
}: {
	question: string;
	options: string;
	onOptionClick: (option: string) => void;
}) {
	const parsedOptions = options
		? options
				.split(',')
				.map((option) => option.trim())
				.filter(Boolean)
		: [];

	return (
		<div
			className="
				flex animate-chat-item flex-col gap-2.5 rounded-lg border border-accent/25
				bg-accent/5 p-3
			"
		>
			<div className="flex items-center gap-2 text-xs font-semibold text-accent">
				<HelpCircle className="size-4" />
				<span>Question</span>
			</div>
			<div className="text-sm/relaxed text-text-primary">{question}</div>
			{parsedOptions.length > 0 && (
				<div className="flex flex-wrap gap-2">
					{parsedOptions.map((option) => (
						<button
							key={option}
							onClick={() => onOptionClick(option)}
							className={cn(
								`
									inline-flex cursor-pointer items-center rounded-md border border-border
									bg-bg-tertiary
								`,
								'px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors',
								'hover:border-accent hover:text-text-primary',
							)}
						>
							{option}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

export function ContinuationPrompt({ onContinue, onDismiss }: { onContinue: () => void; onDismiss: () => void }) {
	return (
		<div
			className="
				flex animate-chat-item flex-col gap-2.5 rounded-lg border border-accent/25
				bg-accent/5 p-3
			"
		>
			<div className="flex items-center gap-2 text-xs font-semibold text-accent">
				<FastForward className="size-4 shrink-0" />
				<span className="truncate">Iteration Limit Reached</span>
			</div>
			<div className="text-sm/relaxed text-text-primary">
				The AI has reached the maximum number of tool iterations. You can continue where it left off or start a new prompt.
			</div>
			<div className="flex flex-wrap gap-2">
				<button
					onClick={onContinue}
					className={cn(
						`
							inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-accent px-3
							py-1.5
						`,
						'text-xs font-medium text-white transition-colors',
						'hover:bg-accent-hover',
					)}
				>
					<FastForward className="size-3" />
					Continue
				</button>
				<button
					onClick={onDismiss}
					className={cn(
						`
							inline-flex cursor-pointer items-center rounded-md border border-border
							bg-bg-tertiary
						`,
						'px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors',
						'hover:bg-border hover:text-text-primary',
					)}
				>
					Dismiss
				</button>
			</div>
		</div>
	);
}

export function DoomLoopAlert({ message, onRetry, onDismiss }: { message: string; onRetry: () => void; onDismiss: () => void }) {
	return (
		<div
			className="
				flex animate-chat-item flex-col gap-2.5 rounded-lg border border-warning/25
				bg-warning/10 p-3
			"
		>
			<div className="flex items-center gap-2 text-xs font-semibold text-warning">
				<RefreshCw className="size-4 shrink-0" />
				<span className="truncate">Loop Detected</span>
			</div>
			<div className="text-sm/relaxed text-text-primary">{message}</div>
			<div className="flex flex-wrap gap-2">
				<button
					onClick={onRetry}
					className={cn(
						`
							inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-accent px-3
							py-1.5
						`,
						'text-xs font-medium text-white transition-colors',
						'hover:bg-accent-hover',
					)}
				>
					<RefreshCw className="size-3" />
					Retry
				</button>
				<button
					onClick={onDismiss}
					className={cn(
						`
							inline-flex cursor-pointer items-center rounded-md border border-border
							bg-bg-tertiary
						`,
						'px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors',
						'hover:bg-border hover:text-text-primary',
					)}
				>
					Dismiss
				</button>
			</div>
		</div>
	);
}

export function AgentError({
	message,
	code,
	onRetry,
	onDismiss,
}: {
	message: string;
	code?: string;
	onRetry?: () => void;
	onDismiss?: () => void;
}) {
	const isRateLimit = code === 'RATE_LIMIT' || code === 'RATE_LIMIT_EXCEEDED' || code === 'OVERLOADED';
	const isRetryable = code !== 'AUTH_ERROR' && code !== 'INVALID_REQUEST';

	return (
		<div
			className={cn(
				'flex animate-chat-item flex-col gap-2.5 rounded-lg border p-3',
				isRateLimit ? 'border-warning/25 bg-warning/10' : 'border-error/25 bg-error/10',
			)}
		>
			<div className={cn('flex items-center gap-2 text-xs font-semibold', isRateLimit ? 'text-warning' : 'text-error')}>
				{isRateLimit ? <Clock className="size-4 shrink-0" /> : <AlertCircle className="size-4 shrink-0" />}
				<span className="truncate">{isRateLimit ? 'Rate Limit Exceeded' : 'Error'}</span>
			</div>
			<div className="text-sm/relaxed text-text-primary">{message}</div>
			<div className="flex flex-wrap gap-2">
				{isRetryable && onRetry && (
					<button
						onClick={onRetry}
						className={cn(
							`
								inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-accent
								px-3 py-1.5
							`,
							`
								text-xs font-medium text-white transition-colors
								hover:bg-accent-hover
							`,
						)}
					>
						<RefreshCw className="size-3" />
						Retry
					</button>
				)}
				{onDismiss && (
					<button
						onClick={onDismiss}
						className={cn(
							`
								inline-flex cursor-pointer items-center rounded-md border border-border
								bg-bg-tertiary
							`,
							'px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors',
							'hover:bg-border hover:text-text-primary',
						)}
					>
						Dismiss
					</button>
				)}
			</div>
		</div>
	);
}
