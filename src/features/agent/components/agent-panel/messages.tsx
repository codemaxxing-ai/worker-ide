import { AssistantMessage } from './messages/assistant-message';
import { UserMessage } from './messages/user-message';

import type { SessionParticipantProfile, SubAgentActivityRecord } from '@shared/agent-state';
import type { AgentMode, ChatMessage, ToolErrorInfo, ToolMetadataInfo } from '@shared/types';

export function MessageBubble({
	message,
	messageIndex,
	currentUserId,
	sessionParticipants,
	agentMode,
	modelId,
	isClientOnly = false,
	canRevert = false,
	isReverting,
	revertingMessageIndex,
	onRevert,
	toolErrors,
	toolMetadata,
	fileDiffContent,
	subAgentActivities,
	projectId,
	showHeader = true,
}: {
	message: ChatMessage;
	messageIndex: number;
	currentUserId?: string;
	sessionParticipants: Record<string, SessionParticipantProfile>;
	agentMode?: AgentMode;
	modelId?: string;
	isClientOnly?: boolean;
	canRevert?: boolean;
	isReverting: boolean;
	revertingMessageIndex?: number;
	onRevert: (messageIndex: number) => void;
	toolErrors?: Map<string, ToolErrorInfo>;
	toolMetadata?: Map<string, ToolMetadataInfo>;
	fileDiffContent?: Map<string, { beforeContent: string; afterContent: string }>;
	subAgentActivities?: Record<string, SubAgentActivityRecord>;
	projectId?: string;
	/**
	 * Whether to show the "AI" header above this message.
	 * Set to false for consecutive assistant messages to group them under one header.
	 */
	showHeader?: boolean;
}) {
	if (message.role === 'user') {
		return (
			<UserMessage
				message={message}
				messageIndex={messageIndex}
				currentUserId={currentUserId}
				sessionParticipants={sessionParticipants}
				agentMode={agentMode}
				modelId={modelId}
				isClientOnly={isClientOnly}
				canRevert={canRevert}
				isReverting={isReverting}
				isRevertingThis={revertingMessageIndex === messageIndex}
				onRevert={onRevert}
			/>
		);
	}

	return (
		<AssistantMessage
			message={message}
			toolErrors={toolErrors}
			toolMetadata={toolMetadata}
			fileDiffContent={fileDiffContent}
			subAgentActivities={subAgentActivities}
			projectId={projectId}
			showHeader={showHeader}
		/>
	);
}
export { WelcomeScreen, UserQuestionPrompt, ContinuationPrompt, DoomLoopAlert, AgentError } from './messages/prompts';
export { AssistantMessage } from './messages/assistant-message';

export { QueuedSteeringStrip } from './messages/queued-steering-strip';
