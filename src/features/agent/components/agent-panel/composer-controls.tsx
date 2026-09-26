import { ArrowUp, Image as ImageIcon, Mic, MicOff, Square } from 'lucide-react';
import { useRef } from 'react';

import { PendingApprovalIndicator } from '@/components/ui/pending-approval-indicator';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { MAX_IMAGE_ATTACHMENTS } from '@shared/constants';

import { ContextRing } from './context-ring';
import { getModelLimits } from './model-config';
import { ModelSelectorDropdown } from './model-selector-dialog';
import { AgentModeSelector } from '../agent-mode-selector';
import { AudioWaveform } from '../audio-waveform';

import type { useSpeechToText } from '../../hooks/use-speech-to-text';
import type { AIModelId } from '@shared/constants';
import type { AgentMode } from '@shared/types';

type ComposerControlsProperties = {
	speechToText: ReturnType<typeof useSpeechToText>;
	agentMode: AgentMode;
	setAgentMode: (mode: AgentMode) => void;
	selectedModel: AIModelId;
	setSelectedModel: (model: AIModelId) => void;
	contextTokensUsed: number;
	imageAttachmentCount: number;
	addImageFiles: (files: File[]) => void;
	onStopRecording: () => void;
	onMicrophoneClick: () => void;
	onSubmit: () => void;
	isConnected: boolean;
	isProcessing: boolean;
	canSubmit: boolean;
};

export function ComposerControls({
	speechToText,
	agentMode,
	setAgentMode,
	selectedModel,
	setSelectedModel,
	contextTokensUsed,
	imageAttachmentCount,
	addImageFiles,
	onStopRecording,
	onMicrophoneClick,
	onSubmit,
	isConnected,
	isProcessing,
	canSubmit,
}: ComposerControlsProperties) {
	const imageFileInputReference = useRef<HTMLInputElement>(null);

	const handleImageFileInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
		const files = event.target.files ? [...event.target.files] : [];
		if (files.length > 0) {
			addImageFiles(files);
		}
		event.target.value = '';
	};

	return (
		<>
			{speechToText.isRecording ? (
				<div className="flex min-w-0 items-center gap-x-1.5 px-1.5 py-1">
					<div className="relative flex size-3 shrink-0 items-center justify-center">
						{speechToText.isAwaitingPermission ? (
							<PendingApprovalIndicator className="size-2" />
						) : (
							<span className="size-2 animate-pulse rounded-full bg-error" />
						)}
					</div>
					<div className={cn('relative h-4', speechToText.isAwaitingPermission ? 'min-w-0 flex-1' : 'w-28 shrink-0')}>
						{speechToText.isAwaitingPermission ? (
							<Tooltip content="Approve microphone access in your browser to start recording" side="top">
								<div
									className="
										flex h-full items-center gap-1.5 text-xs text-text-secondary
									"
								>
									<span className="truncate font-medium text-text-primary">Approve microphone access</span>
									<span className="truncate text-[11px] text-text-secondary/80">Browser prompt waiting</span>
								</div>
							</Tooltip>
						) : (
							<AudioWaveform amplitudes={speechToText.amplitudes} className="absolute inset-0" />
						)}
					</div>
					{!speechToText.isAwaitingPermission && <div className="flex-1" />}
					<button
						type="button"
						onClick={onStopRecording}
						className={cn(
							'inline-flex cursor-pointer items-center gap-1.5 rounded-md p-1',
							'text-xs font-medium text-error transition-colors',
							'hover:bg-error/10',
						)}
						aria-label="Stop recording"
					>
						<Square className="size-4" />
					</button>
				</div>
			) : (
				<div
					className="
						@container flex flex-wrap-reverse items-center gap-x-1.5 gap-y-0.5 px-1.5
						py-1
					"
					data-testid="agent-input-toolbar"
				>
					<AgentModeSelector mode={agentMode} onModeChange={setAgentMode} disabled={false} />
					<ModelSelectorDropdown selectedModel={selectedModel} onSelectModel={setSelectedModel} disabled={false} />
					<div className="ml-auto flex shrink-0 items-center justify-end gap-1" data-testid="agent-input-toolbar-actions">
						<ContextRing tokensUsed={contextTokensUsed} contextWindow={getModelLimits(selectedModel).contextWindow} />
						<input
							ref={imageFileInputReference}
							type="file"
							accept="image/png,image/jpeg,image/webp,image/gif"
							multiple
							className="hidden"
							onChange={handleImageFileInputChange}
							aria-hidden="true"
							tabIndex={-1}
						/>
						<Tooltip content="Attach images" side="top">
							<button
								type="button"
								onClick={() => imageFileInputReference.current?.click()}
								disabled={imageAttachmentCount >= MAX_IMAGE_ATTACHMENTS}
								className={cn(
									`
										inline-flex items-center gap-1.5 rounded-md p-1 text-xs font-medium
										transition-colors
									`,
									imageAttachmentCount >= MAX_IMAGE_ATTACHMENTS
										? 'cursor-not-allowed text-text-secondary opacity-40'
										: `
											cursor-pointer text-text-secondary
											hover:bg-bg-tertiary hover:text-text-primary
										`,
								)}
								aria-label="Attach images"
							>
								<ImageIcon className="size-4" />
							</button>
						</Tooltip>
						{speechToText.microphonePermission !== 'unsupported' && (
							<Tooltip
								content={
									speechToText.microphonePermission === 'denied'
										? 'Microphone blocked'
										: speechToText.needsPermissionApproval
											? 'Approve microphone access in your browser'
											: 'Voice input'
								}
								side="top"
								forceOpen={speechToText.needsPermissionApproval}
							>
								<button
									type="button"
									onClick={onMicrophoneClick}
									disabled={!isConnected}
									className={cn(
										'relative inline-flex items-center gap-1.5 rounded-md p-1',
										'text-xs font-medium transition-colors',
										speechToText.microphonePermission === 'denied'
											? 'cursor-pointer text-text-secondary opacity-50'
											: speechToText.needsPermissionApproval
												? `
													bg-accent/6 text-accent ring-1 ring-accent/15 ring-inset
													hover:bg-accent/10 hover:text-accent
												`
												: isConnected
													? `
														cursor-pointer text-text-secondary
														hover:bg-bg-tertiary hover:text-text-primary
													`
													: 'cursor-not-allowed text-text-secondary opacity-40',
									)}
									aria-label={
										speechToText.microphonePermission === 'denied'
											? 'Microphone blocked'
											: speechToText.needsPermissionApproval
												? 'Approve microphone access in your browser'
												: 'Start voice input'
									}
								>
									{speechToText.microphonePermission === 'denied' ? (
										<MicOff className="size-4" />
									) : (
										<Mic className={cn('size-4', speechToText.needsPermissionApproval && 'animate-pulse')} />
									)}
								</button>
							</Tooltip>
						)}
						<button
							type="button"
							onClick={() => void onSubmit()}
							disabled={!canSubmit}
							className={cn(
								'ml-0.5 inline-flex items-center justify-center rounded-md p-1',
								'text-xs font-medium transition-colors',
								canSubmit
									? `
										cursor-pointer bg-accent text-white
										hover:bg-accent-hover
									`
									: 'cursor-not-allowed text-text-secondary opacity-40',
							)}
							aria-label={isProcessing ? 'Queue message' : 'Send message'}
						>
							<ArrowUp className="size-4" />
						</button>
					</div>
				</div>
			)}
		</>
	);
}
