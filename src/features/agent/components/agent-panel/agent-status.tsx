export function AgentStatus({ message }: { message: string }) {
	return (
		<div role="status" className="animate-chat-item px-1 text-xs">
			<span className="block w-fit max-w-full shimmer-text text-ellipsis">{message}</span>
		</div>
	);
}
