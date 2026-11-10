import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { Modal, ModalBody } from '@/components/ui/modal';
import { createApiClient } from '@/lib/api-client';
import { throwApiError } from '@/lib/api-error';
import { cn } from '@/lib/utils';

import { AgentTranscript } from './agent-transcript';

import type { AgentMessage } from '@shared/agent-chat';

export function AgentBranchDialog({
	projectId,
	sessionId,
	message,
	onClose,
	onRegenerate,
}: {
	projectId: string;
	sessionId: string;
	message: AgentMessage;
	onClose: () => void;
	onRegenerate: (answerId: string) => void;
}) {
	const api = useMemo(() => createApiClient(projectId), [projectId]);
	const [selectedId, setSelectedId] = useState<string | undefined>();
	const branches = useQuery({
		queryKey: ['agent-branches', projectId, sessionId, message.id],
		queryFn: async () => {
			const response = await api.agent.sessions[':sessionId'].branches.$get({ param: { sessionId }, query: { messageId: message.id } });
			if (!response.ok) await throwApiError(response, 'Could not read answer versions');
			return response.json();
		},
	});
	const answers = branches.data?.branches.filter((branch) => branch.role === 'assistant') ?? [];
	const answerId = selectedId ?? answers.at(-1)?.id;
	const history = useQuery({
		queryKey: ['agent-branch', projectId, sessionId, answerId],
		enabled: Boolean(answerId),
		queryFn: async () => {
			const response = await api.agent.sessions[':sessionId'].history.$get({ param: { sessionId }, query: { leafId: answerId } });
			if (!response.ok) await throwApiError(response, 'Could not read this answer');
			return response.json();
		},
	});
	const answer = history.data?.messages.find((item) => item.id === answerId);
	return (
		<Modal
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title="Answer versions"
			className="w-[600px]"
		>
			<ModalBody>
				<div className="mb-4 flex flex-wrap gap-2" aria-label="Choose answer version">
					{answers.map((version, index) => (
						<button
							id={`agent-version-${version.id}`}
							key={version.id}
							aria-pressed={answerId === version.id}
							onClick={() => setSelectedId(version.id)}
							className={cn(
								`
									rounded-sm border px-3 py-1.5 text-xs
									focus-visible:ring-2 focus-visible:ring-accent
								`,
								answerId === version.id ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary',
							)}
						>
							Answer {index + 1}
						</button>
					))}
				</div>
				{branches.isLoading || history.isLoading ? (
					<p role="status" className="text-xs text-text-secondary">
						Loading…
					</p>
				) : answer ? (
					<AgentTranscript messages={[answer]} projectId={projectId} />
				) : (
					<p className="text-xs text-text-secondary">No saved answer.</p>
				)}
				{(branches.error || history.error) && (
					<p role="alert" className="text-xs text-error">
						{branches.error?.message ?? history.error?.message}
					</p>
				)}
				{answer && (
					<button
						id="agent-regenerate-version"
						className="
							mt-4 rounded-sm bg-accent px-3 py-2 text-xs text-bg-primary
							focus-visible:ring-2 focus-visible:ring-accent
						"
						onClick={() => onRegenerate(answer.id)}
					>
						Regenerate from this answer
					</button>
				)}
			</ModalBody>
		</Modal>
	);
}
