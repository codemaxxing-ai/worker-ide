import { ImagePlus, Mic, Send, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { toast } from '@/components/ui/toast-store';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { AI_MODELS } from '@shared/constants';

import { ImageAttachmentStrip } from './image-attachment-strip';
import { useFileMention } from '../../hooks/use-file-mention';
import { useImageAttachments } from '../../hooks/use-image-attachments';
import { useSpeechToText } from '../../hooks/use-speech-to-text';
import { appendPreviewElementSegment, segmentsToMessageParts, segmentsToPlainText } from '../../lib/input-segments';
import { useAgentRuntime } from '../agent-runtime-context';
import { FileMentionDropdown } from '../file-mention-dropdown';
import { RichTextInput } from '../rich-text-input';

import type { RichTextInputHandle } from '../rich-text-input';
import type { AIModelId } from '@shared/constants';
import type { AgentMode, UserMessagePart } from '@shared/types';

export function AgentComposer({
	projectId,
	model,
	mode,
	busy,
	settingsDisabled = false,
	connected,
	onSettings,
	onSubmit,
	onStop,
}: {
	projectId: string;
	model: AIModelId;
	mode: AgentMode;
	busy: boolean;
	settingsDisabled?: boolean;
	connected: boolean;
	onSettings: (settings: { model: AIModelId; mode: AgentMode }) => void;
	onSubmit: (parts: UserMessagePart[]) => Promise<void>;
	onStop: () => void;
}) {
	const { segments, setSegments, cursorPosition, setCursorPosition } = useAgentRuntime();
	const inputReference = useRef<RichTextInputHandle>(null);
	const uploadReference = useRef<HTMLInputElement>(null);
	const submittingReference = useRef(false);
	const [submitting, setSubmitting] = useState(false);
	const files = useStore((state) => state.files);
	const images = useImageAttachments(projectId);
	const speech = useSpeechToText({
		projectId,
		onAutoStop: (text) => {
			if (text) setSegments((current) => [...current, { type: 'text', value: text }]);
		},
	});
	const mention = useFileMention({
		files,
		segments,
		inputValue: segmentsToPlainText(segments),
		cursorPosition,
		onSelect: (path, trigger, length) => inputReference.current?.insertMention(path, trigger, length),
	});
	useEffect(() => {
		const append = () => {
			const pending = useStore.getState().pendingPreviewElementReferences;
			if (pending.length === 0) return;
			setSegments((current) => {
				let result = current;
				for (const reference of pending) result = appendPreviewElementSegment(result, reference);
				return result;
			});
			for (const _reference of pending) useStore.getState().shiftPendingPreviewElementReference();
		};
		append();
		return useStore.subscribe((state, previous) => {
			if (state.pendingPreviewElementReferences !== previous.pendingPreviewElementReferences) append();
		});
	}, [setSegments]);
	async function submit() {
		if (!connected || submittingReference.current || images.hasUploading) return;
		const parts = [...segmentsToMessageParts(segments), ...images.readyImageParts];
		if (!parts.some((part) => part.type !== 'text' || part.content.trim())) return;
		submittingReference.current = true;
		setSubmitting(true);
		try {
			await onSubmit(parts);
			images.clearAttachments();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Message could not be sent');
		} finally {
			submittingReference.current = false;
			setSubmitting(false);
		}
	}
	return (
		<div className="relative shrink-0 border-t border-border bg-bg-secondary p-3">
			{mention.isOpen && (
				<FileMentionDropdown results={mention.results} selectedIndex={mention.selectedIndex} onSelect={mention.selectFile} />
			)}
			<div
				className="
					rounded-xl border border-border bg-bg-primary shadow-sm
					focus-within:border-accent
				"
				onDragOver={(event) => event.preventDefault()}
				onDrop={(event) => {
					event.preventDefault();
					images.addFiles([...event.dataTransfer.files]);
				}}
			>
				<ImageAttachmentStrip attachments={images.attachments} onRemoveAttachment={images.removeAttachment} />
				<RichTextInput
					ref={inputReference}
					segments={segments}
					onSegmentsChange={setSegments}
					onCursorChange={setCursorPosition}
					disabled={submitting || speech.isRecording}
					onPasteFiles={images.addFiles}
					placeholder={busy ? 'Add a follow-up…' : 'What would you like to build?'}
					onKeyDown={(event) => {
						if (mention.handleKeyDown(event)) return;
						if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault();
							void submit();
						}
					}}
				/>
				{speech.isRecording && (
					<p role="status" className="px-3 text-xs text-accent">
						{speech.interimTranscript || 'Listening…'}
					</p>
				)}
				<div className="flex flex-wrap items-center gap-1 border-t border-border/50 p-2">
					<select
						id="agent-session-mode"
						aria-label="Agent mode"
						value={mode}
						disabled={busy || submitting || settingsDisabled}
						onChange={(event) => {
							const value = event.target.value;
							if (value === 'code' || value === 'plan' || value === 'ask') onSettings({ model, mode: value });
						}}
						className="
							rounded-sm bg-bg-secondary p-1 text-xs text-text-primary
							focus-visible:outline-accent
							disabled:opacity-50
						"
					>
						<option value="code">Code</option>
						<option value="plan">Plan</option>
						<option value="ask">Ask</option>
					</select>
					<select
						id="agent-session-model"
						aria-label="AI model"
						value={model}
						disabled={busy || submitting || settingsDisabled}
						onChange={(event) => {
							const selected = AI_MODELS.find((candidate) => candidate.id === event.target.value);
							if (selected) onSettings({ mode, model: selected.id });
						}}
						className="
							max-w-40 min-w-0 rounded-sm bg-bg-secondary p-1 text-xs text-text-primary
							focus-visible:outline-accent
							disabled:opacity-50
						"
					>
						{AI_MODELS.map((item) => (
							<option key={item.id} value={item.id}>
								{item.label}
							</option>
						))}
					</select>
					<div className="ml-auto flex items-center gap-1">
						<input
							id="agent-image-input"
							ref={uploadReference}
							type="file"
							accept="image/*"
							multiple
							className="hidden"
							onChange={(event) => {
								images.addFiles([...(event.target.files ?? [])]);
								event.target.value = '';
							}}
						/>
						<button
							id="agent-attach-image"
							aria-label="Attach images"
							className="
								rounded-sm p-1.5 text-text-secondary
								hover:bg-bg-tertiary
								focus-visible:ring-2 focus-visible:ring-accent
							"
							onClick={() => uploadReference.current?.click()}
						>
							<ImagePlus className="size-4" />
						</button>
						{speech.microphonePermission !== 'unsupported' && (
							<button
								id="agent-dictate"
								aria-label={speech.isRecording ? 'Stop recording' : 'Dictate message'}
								className={cn(
									`
										rounded-sm p-1.5
										focus-visible:ring-2 focus-visible:ring-accent
									`,
									speech.isRecording ? 'text-error' : 'text-text-secondary',
								)}
								onClick={() => {
									if (speech.isRecording) {
										const text = speech.stop();
										if (text) setSegments((current) => [...current, { type: 'text', value: text }]);
									} else void speech.start();
								}}
							>
								<Mic className="size-4" />
							</button>
						)}
						{busy && (
							<button
								id="agent-stop"
								aria-label="Stop agent"
								onClick={onStop}
								className="
									rounded-md bg-error/10 p-1.5 text-error
									focus-visible:ring-2 focus-visible:ring-accent
								"
							>
								<Square className="size-4" />
							</button>
						)}
						<button
							id="agent-send"
							aria-label={busy ? 'Queue message' : 'Send message'}
							disabled={!connected || submitting || images.hasUploading}
							onClick={() => void submit()}
							className="
								rounded-md bg-accent p-1.5 text-bg-primary
								focus-visible:ring-2 focus-visible:ring-accent
								disabled:opacity-40
							"
						>
							<Send className="size-4" />
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
