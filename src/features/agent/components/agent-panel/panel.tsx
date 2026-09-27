import { ScrollArea } from '@base-ui/react/scroll-area';
import { ArrowDown, Download, Map as MapIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { Collapsible } from '@/components/ui/collapsible';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast-store';
import { Tooltip } from '@/components/ui/tooltip';
import { useAgentSessions } from '@/features/agent/hooks/use-agent-sessions';
import { isAgentState } from '@/features/agent/lib/agent-state';
import { useSnapshots } from '@/features/snapshots';
import { useMobileKeyboardLayout } from '@/hooks/use-mobile-keyboard-height';
import { createApiClient, downloadDebugLog } from '@/lib/api-client';
import { authClient } from '@/lib/auth-client';
import { setActiveSessionId } from '@/lib/project-storage';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';

import { ComposerControls } from './composer-controls';
import { ImageAttachmentStrip } from './image-attachment-strip';
import {
	AgentError,
	AssistantMessage,
	ContinuationPrompt,
	DoomLoopAlert,
	MessageBubble,
	QueuedSteeringStrip,
	UserQuestionPrompt,
	WelcomeScreen,
} from './messages';
import { AgentSessionHeader } from './session-header';
import { createOptimisticUserMessage, useAgentMessageTimeline, type OptimisticMessageEntry } from './use-agent-message-timeline';
import { useAutoScroll } from '../../hooks/use-auto-scroll';
import { useChangeReview } from '../../hooks/use-change-review';
import { useFileMention } from '../../hooks/use-file-mention';
import { useImageAttachments } from '../../hooks/use-image-attachments';
import { useSpeechToText } from '../../hooks/use-speech-to-text';
import {
	appendPreviewElementSegment,
	messagePartsToInputSegments,
	parseTextToSegments,
	segmentsToMessageParts,
	segmentsHaveContent,
	segmentsToPlainText,
	type InputSegment,
} from '../../lib/input-segments';
import { useAgentRuntime } from '../agent-runtime-context';
import { BouncingDots } from '../bouncing-dots';
import { ChangedFilesSummary } from '../changed-files-summary';
import { FileMentionDropdown } from '../file-mention-dropdown';
import { RevertConfirmDialog } from '../revert-confirm-dialog';
import { RichTextInput, type RichTextInputHandle } from '../rich-text-input';

import type { SessionParticipantProfile } from '@shared/agent-state';
import type { ChatMessage } from '@shared/types';

function InputInfoBar({ open, icon, children }: { open: boolean; icon: React.ReactNode; children: React.ReactNode }) {
	return (
		<Collapsible open={open}>
			<div
				className="
					flex items-center gap-2 border-b border-warning/30 bg-warning/5 px-2.5
					py-1.5
				"
			>
				{icon}
				{children}
			</div>
		</Collapsible>
	);
}

export function AgentPanel({ projectId, className }: { projectId: string; className?: string }) {
	// On mobile, when the virtual keyboard opens, switch to position:fixed so the
	// panel stays pinned above the keyboard — header and input remain visible.
	const { style: keyboardStyle, ref: keyboardReference } = useMobileKeyboardLayout();
	const [planPath, setPlanPath] = useState<string | undefined>();
	const inputReference = useRef<RichTextInputHandle>(null);

	const lastSurfacedChatErrorReference = useRef<Error | undefined>(undefined);
	const revertInProgressReference = useRef(false);
	const [fileDiffContent, setFileDiffContent] = useState<Map<string, { beforeContent: string; afterContent: string }>>(new Map());
	const [optimisticStoppingSessionId, setOptimisticStoppingSessionId] = useState<string | undefined>();
	const [optimisticMessages, setOptimisticMessages] = useState<OptimisticMessageEntry[]>([]);
	const [optimisticRemovedQueuedMessages, setOptimisticRemovedQueuedMessages] = useState<Array<{ sessionId: string; messageId: string }>>(
		[],
	);
	const { agent, agentConnectionState, isConnected, segments, setSegments, cursorPosition, setCursorPosition } = useAgentRuntime();
	const {
		attachments: imageAttachments,
		addFiles: addImageFiles,
		removeAttachment: removeImageAttachment,
		clearAttachments: clearImageAttachments,
		hasUploading: hasUploadingImages,
		readyImageParts,
	} = useImageAttachments(projectId);
	const [isDraggingImage, setIsDraggingImage] = useState(false);
	const initialCursorPositionReference = useRef(cursorPosition);
	const initialInputPlainTextLengthReference = useRef(segmentsToPlainText(segments).length);

	const inputPlainText = useMemo(() => segmentsToPlainText(segments), [segments]);

	const [pendingRevert, setPendingRevert] = useState<
		{ snapshotIds: string[]; messageIndex: number; isLoading: boolean; error?: string } | undefined
	>();

	const { files, agentMode, selectedModel, openFile, setAgentMode, setSelectedModel, clearPendingChangesByPaths } = useStore(
		useShallow((state) => ({
			files: state.files,
			agentMode: state.agentMode,
			selectedModel: state.selectedModel,
			openFile: state.openFile,
			setAgentMode: state.setAgentMode,
			setSelectedModel: state.setSelectedModel,
			clearPendingChangesByPaths: state.clearPendingChangesByPaths,
		})),
	);
	const { data: session } = authClient.useSession();
	const pendingPreviewElementReferences = useStore((state) => state.pendingPreviewElementReferences);
	const shiftPendingPreviewElementReference = useStore((state) => state.shiftPendingPreviewElementReference);

	const lastProcessedPreviewElementReferenceKeyReference = useRef<string | undefined>(undefined);

	const rawState = agent.state;
	const agentState = isAgentState(rawState) ? rawState : undefined;
	const currentSession = agentState?.currentSession;
	const sessionParticipants: Record<string, SessionParticipantProfile> = agentState?.sessionParticipants ?? {};
	const currentUserId = session?.user.id;
	const sessionId = currentSession?.sessionId;
	const statusMessage = currentSession?.statusText;
	const contextTokensUsed = currentSession?.contextTokensUsed ?? 0;
	const debugLogId = currentSession?.debugLogId;
	const isProcessing = currentSession?.status === 'running';
	const agentError = currentSession?.error;
	const stopRequested = currentSession?.stopRequested ?? false;
	const isStopPending = isProcessing && ((sessionId !== undefined && optimisticStoppingSessionId === sessionId) || stopRequested);
	const pendingQuestion = currentSession?.pendingQuestion;
	const needsContinuation = currentSession?.needsContinuation ?? false;
	const doomLoopMessage = currentSession?.doomLoopMessage;
	const {
		allSessions,
		savedSessions,
		handleLoadSession: loadSession,
		handleRenameSession,
		handleDeleteSession,
		sessionSearchQuery,
		setSessionSearchQuery,
		isRestoringSession,
		sessionSnapshot,
	} = useAgentSessions({
		projectId,
		agent,
		agentConnectionState,
	});
	const {
		renderedSessionId,
		renderedOptimisticEntries,
		renderedOptimisticMessages,
		localOnlyMessageIds,
		serverMessages,
		allMessages,
		queuedMessages,
		committedMessages,
	} = useAgentMessageTimeline({
		sessionId,
		currentSession,
		sessionSnapshot,
		optimisticMessages,
		optimisticRemovedQueuedMessages,
	});
	// Derive tool metadata/errors/sub-agent activities directly from agent state via useMemo
	const toolMetadata = useMemo(
		() => new Map([...Object.entries(sessionSnapshot?.toolMetadata ?? {}), ...Object.entries(currentSession?.toolMetadata ?? {})]),
		[currentSession?.toolMetadata, sessionSnapshot?.toolMetadata],
	);
	const toolErrors = useMemo(
		() => new Map([...Object.entries(sessionSnapshot?.toolErrors ?? {}), ...Object.entries(currentSession?.toolErrors ?? {})]),
		[currentSession?.toolErrors, sessionSnapshot?.toolErrors],
	);
	const subAgentActivities = useMemo(() => currentSession?.subAgentActivities ?? {}, [currentSession?.subAgentActivities]);

	// Stable ref for sessionId access in callbacks
	const sessionIdReference = useRef(sessionId);
	useEffect(() => {
		sessionIdReference.current = sessionId;
	}, [sessionId]);
	const optimisticMessagesReference = useRef(optimisticMessages);
	useEffect(() => {
		optimisticMessagesReference.current = optimisticMessages;
	}, [optimisticMessages]);
	const flushingClientQueueReference = useRef(false);

	// Smart auto-scroll: stops when user scrolls up, shows pill for new content.
	const { scrollReference, anchorReference, wrapperReference, hasNewContent, scrollToBottom, resetScrollState } = useAutoScroll();

	// Sync isProcessing to the Zustand store so external components
	// (mobile-tab-bar, ide-shell) can read it.
	useEffect(() => {
		queueMicrotask(() => useStore.getState().setProcessing(isProcessing));
	}, [isProcessing]);

	useEffect(() => {
		if (!optimisticStoppingSessionId) return;
		if (sessionId !== optimisticStoppingSessionId || stopRequested || !isProcessing) {
			queueMicrotask(() => setOptimisticStoppingSessionId(undefined));
		}
	}, [optimisticStoppingSessionId, sessionId, stopRequested, isProcessing]);

	useEffect(() => {
		if (!renderedSessionId) return;
		const persistedIds = new Set(serverMessages.map((message) => message.id));
		queueMicrotask(() =>
			setOptimisticMessages((previous) =>
				previous.filter((entry) => {
					if (entry.sessionId !== renderedSessionId) {
						return true;
					}
					return !persistedIds.has(entry.message.id);
				}),
			),
		);
	}, [renderedSessionId, serverMessages]);

	useEffect(() => {
		if (!renderedSessionId) return;
		const liveIds = new Set([...serverMessages.map((message) => message.id), ...renderedOptimisticMessages.map((message) => message.id)]);
		queueMicrotask(() =>
			setOptimisticRemovedQueuedMessages((previous) =>
				previous.filter((entry) => entry.sessionId !== renderedSessionId || liveIds.has(entry.messageId)),
			),
		);
	}, [renderedOptimisticMessages, renderedSessionId, serverMessages]);

	// Reset per-session UI state when the session changes
	const previousSessionIdReference = useRef(sessionId);
	useEffect(() => {
		if (sessionId !== previousSessionIdReference.current) {
			previousSessionIdReference.current = sessionId;
			queueMicrotask(() => {
				setPlanPath(undefined);
			});
		}
	}, [sessionId]);

	// Sync chatError from agent state to local error display.
	// Only surface it once — if the user dismisses it, don't re-trigger
	// until a genuinely new error arrives from the agent.
	// Track displayed error to avoid re-surfacing after dismiss
	const displayedError = agentError?.message;
	useEffect(() => {
		if (displayedError) {
			lastSurfacedChatErrorReference.current = new Error(displayedError);
		}
	}, [displayedError]);

	// File mention autocomplete
	const handleFileMentionSelect = useCallback((path: string, triggerIndex: number, queryLength: number) => {
		inputReference.current?.insertMention(path, triggerIndex, queryLength);
	}, []);

	const {
		isOpen: isFileMentionOpen,
		results: fileMentionResults,
		selectedIndex: fileMentionSelectedIndex,
		handleKeyDown: handleFileMentionKeyDown,
		selectFile: selectMentionFile,
	} = useFileMention({
		files,
		segments,
		inputValue: inputPlainText,
		cursorPosition,
		onSelect: handleFileMentionSelect,
	});

	// Snapshot hook for revert
	const { revertCascadeAsync, isReverting } = useSnapshots({ projectId });

	// Change review hook for accept/reject UI
	const changeReview = useChangeReview({ projectId });

	// Segments captured at the moment recording starts, so we can
	// prepend them to the voice transcript on stop.
	const [preRecordingSegments, setPreRecordingSegments] = useState<InputSegment[]>([]);

	// Append a transcript string to whatever the user already typed
	const appendTranscriptToInput = useCallback(
		(transcript: string) => {
			if (!transcript) {
				// No transcript — restore pre-recording segments unchanged
				setSegments(preRecordingSegments);
				return;
			}
			const knownPaths = new Set(files.map((file) => file.path));
			const transcriptSegments = parseTextToSegments(transcript, knownPaths);
			const existingText = segmentsToPlainText(preRecordingSegments);

			// Add a space separator if the existing text doesn't end with whitespace
			const needsSpace = existingText.length > 0 && !/\s$/.test(existingText);
			const merged: InputSegment[] = [
				...preRecordingSegments,
				...(needsSpace ? [{ type: 'text' as const, value: ' ' }] : []),
				...transcriptSegments,
			];
			setSegments(merged);
			requestAnimationFrame(() => {
				inputReference.current?.focus();
				inputReference.current?.moveCursorToEnd();
			});
		},
		[files, preRecordingSegments, setSegments],
	);

	// Speech-to-text hook for voice input
	const speechToText = useSpeechToText({ projectId, onAutoStop: appendTranscriptToInput });
	const liveTranscript = useMemo(
		() => [speechToText.finalTranscript, speechToText.interimTranscript].filter(Boolean).join(' '),
		[speechToText.finalTranscript, speechToText.interimTranscript],
	);
	const recordingSegments = useMemo(() => {
		if (!speechToText.isRecording) {
			return segments;
		}

		const existingText = segmentsToPlainText(preRecordingSegments);
		const needsSpace = existingText.length > 0 && liveTranscript.length > 0 && !/\s$/.test(existingText);
		return [
			...preRecordingSegments,
			...(needsSpace ? [{ type: 'text' as const, value: ' ' }] : []),
			...(liveTranscript ? [{ type: 'text' as const, value: liveTranscript }] : []),
		];
	}, [liveTranscript, preRecordingSegments, segments, speechToText.isRecording]);
	const visibleInputSegments = speechToText.isRecording ? recordingSegments : segments;
	const hasVisibleInputContent = useMemo(() => segmentsHaveContent(visibleInputSegments), [visibleInputSegments]);
	const canSubmit = (hasVisibleInputContent || readyImageParts.length > 0) && !hasUploadingImages;

	// Move cursor to end of input as transcript grows during recording
	useEffect(() => {
		if (speechToText.isRecording && (speechToText.finalTranscript || speechToText.interimTranscript)) {
			requestAnimationFrame(() => {
				inputReference.current?.moveCursorToEnd();
			});
		}
	}, [speechToText.isRecording, speechToText.finalTranscript, speechToText.interimTranscript]);

	// Handle manually stopping STT and inserting the transcript into the input
	const handleStopRecording = useCallback(() => {
		const transcript = speechToText.stop();
		appendTranscriptToInput(transcript || liveTranscript);
	}, [speechToText, appendTranscriptToInput, liveTranscript]);

	const handleMicrophoneClick = useCallback(() => {
		if (speechToText.isRecording) {
			handleStopRecording();
			return;
		}

		if (speechToText.microphonePermission === 'denied') {
			toast.info('Allow microphone access for this site in your browser settings, then try again.');
			return;
		}

		setPreRecordingSegments(segments);
		void speechToText.start();
	}, [handleStopRecording, segments, speechToText]);

	// Start a new session. Pending changes are NOT cleared — they persist
	// across sessions at the project level.
	const clearHistory = useCallback(() => {
		if (!isConnected) return;
		setPlanPath(undefined);
		setFileDiffContent(new Map());
		setOptimisticMessages([]);
		setOptimisticRemovedQueuedMessages([]);
		setActiveSessionId(projectId, undefined);
		// Tell the agent to clear the current session state via RPC
		// (also aborts any running session server-side)
		void agent.stub.clearCurrentSession(isProcessing ? sessionId : undefined).catch((error: unknown) => {
			console.error('[AgentPanel] Failed to clear current session:', error);
			toast.error('Could not start a new session. Please try again.');
		});
	}, [projectId, isConnected, isProcessing, sessionId, agent]);

	// Load a session via Agent RPC and clear transient UI state
	const handleLoadSession = useCallback(
		(targetSessionId: string) => {
			if (!isConnected) return;
			if (targetSessionId === sessionId) return;
			if (isProcessing) {
				void agent.stub.abortRun(sessionId).catch((error: unknown) => {
					console.error('[AgentPanel] Failed to stop session before loading another:', error);
				});
			}
			setPlanPath(undefined);
			setFileDiffContent(new Map());
			setOptimisticMessages([]);
			setOptimisticRemovedQueuedMessages([]);
			resetScrollState();
			loadSession(targetSessionId);
		},
		[loadSession, isConnected, isProcessing, sessionId, agent, resetScrollState],
	);

	useEffect(() => {
		return useStore.subscribe((state, previousState) => {
			const requested = state.requestedAgentSessionId;
			if (!requested || requested === previousState.requestedAgentSessionId) return;
			state.clearRequestedAgentSession();
			if (!isConnected) return;
			if (requested === sessionId) return;
			handleLoadSession(requested);
		});
	}, [handleLoadSession, isConnected, sessionId]);

	// Focus input on mount
	useEffect(() => {
		const restoredCursorPosition = Math.max(
			0,
			Math.min(initialCursorPositionReference.current, initialInputPlainTextLengthReference.current),
		);
		// Small delay to let contentEditable mount
		requestAnimationFrame(() => {
			inputReference.current?.focus();
			inputReference.current?.setCursorPosition(restoredCursorPosition);
		});
	}, []);

	useEffect(() => {
		const nextReference = pendingPreviewElementReferences[0];
		if (!nextReference) {
			lastProcessedPreviewElementReferenceKeyReference.current = undefined;
			return;
		}

		const referenceKey = `${nextReference.primarySelector}|${nextReference.tagName}`;
		if (lastProcessedPreviewElementReferenceKeyReference.current === referenceKey) {
			return;
		}

		lastProcessedPreviewElementReferenceKeyReference.current = referenceKey;

		setSegments((previous) => appendPreviewElementSegment(previous, nextReference));
		shiftPendingPreviewElementReference();

		requestAnimationFrame(() => {
			inputReference.current?.focus();
			inputReference.current?.moveCursorToEnd();
		});
	}, [pendingPreviewElementReferences, setSegments, shiftPendingPreviewElementReference]);

	const submitOptimisticMessage = useCallback(
		async (entry: OptimisticMessageEntry): Promise<boolean> => {
			const request = entry.message.metadata?.request;
			if (!request?.mode || !request.model || entry.message.parts.length === 0) {
				setOptimisticMessages((previous) => previous.filter((candidate) => candidate.message.id !== entry.message.id));
				return false;
			}

			setOptimisticMessages((previous) =>
				previous.map((candidate) => (candidate.message.id === entry.message.id ? { ...candidate, submitting: true } : candidate)),
			);

			try {
				const result = await agent.stub.submitMessage({
					parts: entry.message.parts,
					sessionId: entry.sessionId,
					mode: request.mode,
					model: request.model,
					messageId: entry.message.id,
					createdAt: entry.message.createdAt ?? Date.now(),
				});

				setActiveSessionId(projectId, result.sessionId);
				setOptimisticMessages((previous) =>
					previous.map((candidate) =>
						candidate.message.id === entry.message.id
							? {
									...candidate,
									sessionId: result.sessionId,
									clientOnly: false,
									submitting: false,
									message: {
										...candidate.message,
										metadata: {
											...candidate.message.metadata,
											request: {
												...candidate.message.metadata?.request,
												state: result.queued ? 'queued' : 'committed',
											},
										},
									},
								}
							: candidate,
					),
				);

				return true;
			} catch (error: unknown) {
				if (!agent.identified) {
					setOptimisticMessages((previous) =>
						previous.map((candidate) =>
							candidate.message.id === entry.message.id ? { ...candidate, clientOnly: true, submitting: false } : candidate,
						),
					);
					return false;
				}

				setOptimisticMessages((previous) => previous.filter((candidate) => candidate.message.id !== entry.message.id));
				if (error instanceof Error && error.name === 'AbortError') {
					return false;
				}
				console.error('[AgentPanel] Failed to submit message:', error);
				toast.error('Could not send the message. Please try again.');
				return false;
			}
		},
		[agent, projectId],
	);

	useEffect(() => {
		if (!isConnected || flushingClientQueueReference.current) return;
		if (!optimisticMessages.some((entry) => entry.clientOnly && !entry.submitting)) return;

		flushingClientQueueReference.current = true;
		void (async () => {
			try {
				while (agent.identified) {
					const nextEntry = optimisticMessagesReference.current.find((entry) => entry.clientOnly && !entry.submitting);
					if (!nextEntry) break;
					const submitted = await submitOptimisticMessage(nextEntry);
					if (!submitted && !agent.identified) break;
				}
			} finally {
				flushingClientQueueReference.current = false;
			}
		})();
	}, [agent.identified, isConnected, optimisticMessages, submitOptimisticMessage]);

	// Submit a new request. The server decides whether it starts immediately or queues.
	const handleSubmit = useCallback(
		async (messageOverride?: string) => {
			if (!messageOverride && hasUploadingImages) {
				toast.error('Please wait for images to finish uploading.');
				return;
			}
			const knownPaths = new Set(files.map((file) => file.path));
			const messageSegments = messageOverride ? parseTextToSegments(messageOverride.trim(), knownPaths) : visibleInputSegments;
			const messageParts = messageOverride
				? segmentsToMessageParts(messageSegments)
				: [...segmentsToMessageParts(messageSegments), ...readyImageParts];
			if (messageParts.length === 0 || (!messageOverride && !hasVisibleInputContent && readyImageParts.length === 0)) return;

			const resolvedSessionId = sessionId ?? crypto.randomUUID().replaceAll('-', '').slice(0, 16);
			const optimisticMessageId = crypto.randomUUID();
			const optimisticCreatedAt = Date.now();
			const optimisticMessage = createOptimisticUserMessage(
				messageParts,
				agentMode,
				selectedModel,
				isProcessing || isStopPending || stopRequested ? 'queued' : 'committed',
				currentUserId,
				optimisticMessageId,
				optimisticCreatedAt,
			);

			if (!sessionId) {
				setActiveSessionId(projectId, resolvedSessionId);
			}

			const optimisticEntry: OptimisticMessageEntry = {
				sessionId: resolvedSessionId,
				message: optimisticMessage,
				clientOnly: !isConnected,
				submitting: false,
			};

			setOptimisticMessages((previous) => [...previous, optimisticEntry]);
			if (speechToText.isRecording) {
				speechToText.stop();
				setPreRecordingSegments([]);
			}
			setSegments([]);
			clearImageAttachments();
			setOptimisticStoppingSessionId(undefined);
			inputReference.current?.clear();
			scrollToBottom();

			if (isConnected) {
				await submitOptimisticMessage(optimisticEntry);
			}
		},
		[
			files,
			visibleInputSegments,
			setSegments,
			hasVisibleInputContent,
			isConnected,
			isProcessing,
			isStopPending,
			stopRequested,
			sessionId,
			projectId,
			agentMode,
			selectedModel,
			currentUserId,
			scrollToBottom,
			speechToText,
			submitOptimisticMessage,
			hasUploadingImages,
			readyImageParts,
			clearImageAttachments,
		],
	);

	const handleInputDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
		if (![...event.dataTransfer.items].some((item) => item.kind === 'file')) {
			return;
		}
		event.preventDefault();
		setIsDraggingImage(true);
	}, []);

	const handleInputDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
		const related = event.relatedTarget;
		if (related instanceof Node && event.currentTarget.contains(related)) {
			return;
		}
		setIsDraggingImage(false);
	}, []);

	const handleInputDrop = useCallback(
		(event: React.DragEvent<HTMLDivElement>) => {
			const files = [...event.dataTransfer.files].filter((file) => file.type.startsWith('image/'));
			if (files.length === 0) {
				return;
			}
			event.preventDefault();
			setIsDraggingImage(false);
			addImageFiles(files);
		},
		[addImageFiles],
	);

	const handleRemoveQueuedMessage = useCallback(
		(messageId: string) => {
			if (!renderedSessionId) return;

			const optimisticQueuedEntry = renderedOptimisticEntries.find((entry) => entry.message.id === messageId);
			if (optimisticQueuedEntry?.clientOnly && !optimisticQueuedEntry.submitting) {
				setOptimisticMessages((previous) =>
					previous.filter((entry) => !(entry.sessionId === renderedSessionId && entry.message.id === messageId)),
				);
				return;
			}

			const optimisticQueuedMessage = optimisticQueuedEntry?.message;
			setOptimisticMessages((previous) =>
				previous.filter((entry) => !(entry.sessionId === renderedSessionId && entry.message.id === messageId)),
			);
			setOptimisticRemovedQueuedMessages((previous) => {
				if (previous.some((entry) => entry.sessionId === renderedSessionId && entry.messageId === messageId)) {
					return previous;
				}
				return [...previous, { sessionId: renderedSessionId, messageId }];
			});

			void agent.stub
				.removeQueuedMessage(renderedSessionId, messageId)
				.then((result) => {
					if (result.removed) return;
					setOptimisticRemovedQueuedMessages((previous) =>
						previous.filter((entry) => !(entry.sessionId === renderedSessionId && entry.messageId === messageId)),
					);
					if (optimisticQueuedMessage) {
						setOptimisticMessages((previous) => [
							...previous,
							{ sessionId: renderedSessionId, message: optimisticQueuedMessage, clientOnly: false, submitting: false },
						]);
					}
				})
				.catch((error: unknown) => {
					setOptimisticRemovedQueuedMessages((previous) =>
						previous.filter((entry) => !(entry.sessionId === renderedSessionId && entry.messageId === messageId)),
					);
					if (optimisticQueuedMessage) {
						setOptimisticMessages((previous) => [
							...previous,
							{ sessionId: renderedSessionId, message: optimisticQueuedMessage, clientOnly: false, submitting: false },
						]);
					}
					console.error('[AgentPanel] Failed to remove queued message:', error);
					toast.error('Could not remove the queued message. Please try again.');
				});
		},
		[agent, renderedOptimisticEntries, renderedSessionId],
	);

	// Cancel (hard abort) the current request.
	const handleCancel = useCallback(() => {
		if (!sessionId || !isProcessing || stopRequested || optimisticStoppingSessionId === sessionId) return;
		setOptimisticStoppingSessionId(sessionId);
		void agent.stub.abortRun(sessionId).catch((error: unknown) => {
			setOptimisticStoppingSessionId((currentSessionId) => (currentSessionId === sessionId ? undefined : currentSessionId));
			console.error('[AgentPanel] Failed to abort agent:', error);
			toast.error('Could not stop the agent. Please try again.');
		});
	}, [agent, sessionId, isProcessing, optimisticStoppingSessionId, stopRequested]);

	// Handle keyboard shortcuts
	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent) => {
			// Block keyboard shortcuts while recording — the input shows the
			// live transcript and is disabled, so there's nothing to send.
			if (speechToText.isRecording) return;

			// Let file mention dropdown handle keys first
			if (handleFileMentionKeyDown(event)) return;

			if (event.key === 'Enter' && !event.shiftKey) {
				event.preventDefault();
				void handleSubmit();
				return;
			}

			// Escape during processing = hard abort
			if (event.key === 'Escape' && isProcessing) {
				event.preventDefault();
				handleCancel();
			}
		},
		[handleSubmit, handleFileMentionKeyDown, isProcessing, handleCancel, speechToText.isRecording],
	);

	// Retry: trim the failed assistant response and re-start the agent
	const handleRetry = useCallback(() => {
		const lastUser = committedMessages.toReversed().find((message) => message.role === 'user');
		if (!lastUser) return;

		const lastUserIndex = committedMessages.lastIndexOf(lastUser);
		if (lastUserIndex === -1) return;

		const trimmedHistory = committedMessages.slice(0, lastUserIndex + 1);
		const resolvedSessionId = sessionId ?? crypto.randomUUID().replaceAll('-', '').slice(0, 16);
		const retryRequestId = crypto.randomUUID();

		setOptimisticStoppingSessionId(undefined);
		void agent.stub
			.startRun({
				messages: trimmedHistory,
				mode: agentMode,
				model: selectedModel,
				sessionId: resolvedSessionId,
				requestId: retryRequestId,
			})
			.catch((error: unknown) => {
				console.error('[AgentPanel] Failed to retry:', error);
			});
	}, [committedMessages, sessionId, agentMode, selectedModel, agent]);

	// Dismiss error — track locally since error comes from agent state
	const [dismissedError, setDismissedError] = useState<string | undefined>();
	const displayError = agentError && agentError.message !== dismissedError ? agentError : undefined;
	const handleDismissError = useCallback(() => {
		if (agentError) setDismissedError(agentError.message);
	}, [agentError]);

	// Open revert confirmation dialog.
	// Computes the full cascade set: all snapshot IDs from the clicked message forward
	// within the current session, so the dialog can show what will be reverted.
	const handleRevert = useCallback(
		(messageIndex: number) => {
			const sortedSnapshotIds = committedMessages
				.slice(messageIndex)
				.map((message) => message.metadata?.snapshotId)
				.filter((snapshotId): snapshotId is string => !!snapshotId)
				.toReversed();

			setPendingRevert({ snapshotIds: sortedSnapshotIds, messageIndex, isLoading: false });
		},
		[committedMessages],
	);

	// Confirm revert (called from the dialog).
	// Cascade-reverts all snapshots from the clicked message forward within the session,
	// then surgically clears only the affected pending changes.
	const handleConfirmRevert = useCallback(
		async (snapshotIds: string[], messageIndex: number) => {
			if (!sessionId) return;

			// Mark loading state on the dialog
			setPendingRevert((previous) => (previous ? { ...previous, isLoading: true, error: undefined } : previous));

			revertInProgressReference.current = true;
			if (isProcessing) {
				void agent.stub.abortRun(sessionId).catch((error: unknown) => {
					console.error('[AgentPanel] Failed to stop session before revert:', error);
				});
			}

			// Extract the user prompt text before removing messages
			const userMessage = committedMessages[messageIndex];
			const promptSegments = userMessage ? messagePartsToInputSegments(userMessage.parts, new Set(files.map((file) => file.path))) : [];

			try {
				const result = snapshotIds.length > 0 ? await revertCascadeAsync(snapshotIds) : { reverted: [], failed: [], missingSnapshots: [] };

				// Build the set of successfully reverted file paths
				const revertedPaths = new Set(result.reverted.map((file) => file.path));

				// For files that failed to revert on the backend, attempt a fallback:
				// use beforeContent from pending changes to restore the original file.
				const { pendingChanges: currentPendingChanges } = useStore.getState();
				const apiClient = createApiClient(projectId);
				const unrevertedFiles: string[] = [];
				for (const failed of result.failed) {
					const change = currentPendingChanges.get(failed.path);
					if (change?.beforeContent !== undefined && change.action === 'edit') {
						try {
							await apiClient.file.$put({ json: { path: failed.path, content: change.beforeContent } });
							revertedPaths.add(failed.path);
						} catch {
							console.error(`Fallback revert failed for ${failed.path}`);
							unrevertedFiles.push(failed.path.split('/').pop() ?? failed.path);
						}
					} else if (change?.action === 'create') {
						try {
							await apiClient.file.$delete({ query: { path: failed.path } });
							revertedPaths.add(failed.path);
						} catch {
							console.error(`Fallback delete failed for ${failed.path}`);
							unrevertedFiles.push(failed.path.split('/').pop() ?? failed.path);
						}
					}
				}
				if (unrevertedFiles.length > 0) {
					toast.error(
						`Could not revert ${unrevertedFiles.join(', ')}. ${unrevertedFiles.length === 1 ? 'This file' : 'These files'} may still contain AI changes — please check manually.`,
					);
				}

				// Optimistically clear only this session's pending changes for reverted files.
				// Other sessions' changes at the same paths are preserved.
				// The server's revertSession will confirm/reconcile via agent state sync.
				clearPendingChangesByPaths(revertedPaths, sessionId);

				// Revert messages on the server — awaited so errors surface in the dialog
				// and the dialog stays open until the server confirms the revert.
				await agent.stub.revertSession(sessionId, messageIndex);

				// Restore the prompt text into the input, parsing file mentions back into pills
				if (promptSegments.length > 0) {
					setSegments(promptSegments);
					requestAnimationFrame(() => {
						inputReference.current?.focus();
					});
				}

				// The server's revertSession authoritatively updates pending changes
				// via agent state sync — no need to persist from the client.
				queueMicrotask(() => {
					revertInProgressReference.current = false;
				});

				// Force the preview iframe to remount so it reflects the reverted files.
				// The server-side HMR triggers (full-reload per file) may not be reliable
				// if the preview was in a broken state or multiple reloads debounced.
				globalThis.dispatchEvent(new CustomEvent('preview-force-refresh'));

				// Close the dialog on success
				setPendingRevert(undefined);

				// Warn if there were missing snapshots that couldn't be found
				if (result.missingSnapshots.length > 0) {
					console.warn('Some snapshots were not found during cascade revert:', result.missingSnapshots);
				}
			} catch (error) {
				revertInProgressReference.current = false;
				// Show error in the dialog — don't close it, let the user retry or cancel
				const message = error instanceof Error ? error.message : 'Failed to revert changes';
				setPendingRevert((previous) => (previous ? { ...previous, isLoading: false, error: message } : previous));
			}
		},
		[isProcessing, committedMessages, projectId, sessionId, files, agent, revertCascadeAsync, clearPendingChangesByPaths, setSegments],
	);

	// Download debug log
	const handleDownloadDebugLog = useCallback(() => {
		if (!debugLogId) return;
		void downloadDebugLog(projectId, debugLogId, sessionId).catch(() => {
			toast.error('Could not download the debug log. Please try again.');
		});
	}, [debugLogId, projectId, sessionId]);

	const handleSuggestion = useCallback(
		(prompt: string) => {
			void handleSubmit(prompt);
		},
		[handleSubmit],
	);

	const streamingAssistantMessage = useMemo((): ChatMessage | undefined => {
		if (!isProcessing) return undefined;
		const last = committedMessages.at(-1);
		if (last && last.role === 'assistant' && last.parts.length > 0) {
			return last;
		}
		return undefined;
	}, [isProcessing, committedMessages]);

	const displayMessages = useMemo(() => {
		if (streamingAssistantMessage) {
			return committedMessages.slice(0, -1);
		}
		return committedMessages;
	}, [committedMessages, streamingAssistantMessage]);

	let inputPlaceholder = 'Ask anything...';
	if (agentMode === 'plan') {
		inputPlaceholder = 'Describe what to plan...';
	} else if (agentMode === 'ask') {
		inputPlaceholder = 'Ask a question...';
	}

	return (
		<div ref={keyboardReference} className={cn('flex h-full flex-col bg-bg-secondary', className)} style={keyboardStyle}>
			<AgentSessionHeader
				hasSession={allMessages.length > 0}
				allSessions={allSessions}
				savedSessions={savedSessions}
				sessionId={sessionId}
				isConnected={isConnected}
				agentConnectionState={agentConnectionState}
				isProcessing={isProcessing}
				isStopPending={isStopPending}
				needsAttention={!!pendingQuestion || needsContinuation || !!doomLoopMessage}
				sessionSearchQuery={sessionSearchQuery}
				setSessionSearchQuery={setSessionSearchQuery}
				handleLoadSession={handleLoadSession}
				handleRenameSession={handleRenameSession}
				handleDeleteSession={handleDeleteSession}
				handleCancel={handleCancel}
				clearHistory={clearHistory}
			/>

			<div ref={wrapperReference} className="group/scroll relative flex-1 overflow-hidden">
				<div
					className="
						pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-linear-to-b
						from-bg-secondary to-transparent opacity-0 transition-opacity duration-200
						group-data-can-scroll-up/scroll:opacity-100
					"
				/>

				<ScrollArea.Root className="size-full">
					<ScrollArea.Viewport ref={scrollReference} className="size-full">
						<div className="flex min-w-0 flex-col gap-3 p-2">
							{displayMessages.length === 0 && !streamingAssistantMessage ? (
								isRestoringSession ? (
									<div
										className="
											flex flex-1 flex-col items-center justify-center gap-2 py-12
											text-text-secondary
										"
									>
										<Spinner className="size-5" />
										<span className="text-sm">Restoring session...</span>
									</div>
								) : (
									<WelcomeScreen onSuggestionClick={handleSuggestion} onModeChange={setAgentMode} />
								)
							) : (
								<>
									{displayMessages.map((message, index) => (
										<MessageBubble
											key={message.id}
											message={message}
											messageIndex={index}
											currentUserId={currentUserId}
											sessionParticipants={sessionParticipants}
											agentMode={message.metadata?.request?.mode}
											modelId={message.metadata?.request?.model}
											isClientOnly={localOnlyMessageIds.has(message.id)}
											canRevert={message.role === 'user' && (!isProcessing || index < committedMessages.length - 1)}
											isReverting={isReverting}
											revertingMessageIndex={pendingRevert?.isLoading ? pendingRevert.messageIndex : undefined}
											onRevert={handleRevert}
											toolErrors={toolErrors}
											toolMetadata={toolMetadata}
											fileDiffContent={fileDiffContent}
											subAgentActivities={subAgentActivities}
											projectId={projectId}
											showHeader={message.role !== 'assistant' || index === 0 || displayMessages[index - 1]?.role !== 'assistant'}
										/>
									))}
								</>
							)}
							{streamingAssistantMessage && (
								<AssistantMessage
									message={streamingAssistantMessage}
									streaming
									toolErrors={toolErrors}
									toolMetadata={toolMetadata}
									fileDiffContent={fileDiffContent}
									subAgentActivities={subAgentActivities}
									projectId={projectId}
									showHeader={displayMessages.length === 0 || displayMessages.at(-1)?.role !== 'assistant'}
								/>
							)}
							{pendingQuestion && !isProcessing && (
								<UserQuestionPrompt
									question={pendingQuestion.question}
									options={pendingQuestion.options}
									onOptionClick={(option) => void handleSubmit(option)}
								/>
							)}
							{needsContinuation && !isProcessing && (
								<ContinuationPrompt onContinue={() => void handleSubmit('continue')} onDismiss={() => {}} />
							)}
							{doomLoopMessage && !isProcessing && <DoomLoopAlert message={doomLoopMessage} onRetry={handleRetry} onDismiss={() => {}} />}
							{displayError && (
								<AgentError message={displayError.message} code={displayError.code} onRetry={handleRetry} onDismiss={handleDismissError} />
							)}
							{statusMessage ? (
								<div
									className="
										shimmer-text flex animate-chat-item items-center gap-2 px-1 text-xs
									"
								>
									{statusMessage}
								</div>
							) : undefined}

							{!isProcessing && committedMessages.length > 0 && committedMessages.at(-1)?.role === 'assistant' && (
								<div className="flex animate-chat-item items-center justify-end gap-2 px-2">
									{debugLogId && (
										<Tooltip content="Download debug log" side="bottom">
											<button
												onClick={handleDownloadDebugLog}
												className={cn(
													`
														inline-flex cursor-pointer items-center gap-1.5 rounded-md px-1.5
														py-1
													`,
													'text-xs font-medium text-text-secondary transition-colors',
													'hover:bg-bg-tertiary hover:text-text-primary',
												)}
											>
												<Download className="size-3" />
												Agent Log
											</button>
										</Tooltip>
									)}
								</div>
							)}

							<div ref={anchorReference} className="h-px shrink-0" aria-hidden />
						</div>
					</ScrollArea.Viewport>
					<ScrollArea.Scrollbar className="flex w-2 touch-none bg-transparent p-0.5 select-none" orientation="vertical">
						<ScrollArea.Thumb className="relative flex-1 rounded-full bg-border" />
					</ScrollArea.Scrollbar>
				</ScrollArea.Root>

				<div
					className="
						pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-linear-to-t
						from-bg-secondary to-transparent opacity-0 transition-opacity duration-200
						group-data-can-scroll-down/scroll:opacity-100
					"
				/>

				{hasNewContent && (
					<button
						type="button"
						onClick={scrollToBottom}
						className={cn(
							'absolute bottom-3 left-1/2 z-20 -translate-x-1/2',
							'flex cursor-pointer items-center gap-1.5 rounded-full',
							'border border-border bg-bg-primary px-3 py-1.5',
							'text-xs font-medium text-accent shadow-md',
							'animate-chat-item transition-colors',
							'hover:bg-bg-tertiary',
						)}
					>
						<ArrowDown className="size-3" />
						Follow along
					</button>
				)}
			</div>

			<div className="shrink-0 border-t border-border">
				<Collapsible open={changeReview.sessionPendingCount(sessionId) > 0} className="overflow-hidden">
					<div className="px-2 pt-2">
						<ChangedFilesSummary
							onApproveChange={changeReview.handleApproveChange}
							onRejectChange={changeReview.handleRejectChange}
							onApproveAll={() => changeReview.handleApproveAll(sessionId)}
							onRejectAll={() => changeReview.handleRejectAll(sessionId)}
							isReverting={changeReview.isReverting}
							canReject={changeReview.canReject}
							sessionId={sessionId}
						/>
					</div>
				</Collapsible>

				<div className="relative p-2">
					{/* Render outside the clipped input shell so the suggestions can overflow normally. */}
					{isFileMentionOpen && (
						<FileMentionDropdown results={fileMentionResults} selectedIndex={fileMentionSelectedIndex} onSelect={selectMentionFile} />
					)}
					<div className="flex flex-col gap-2">
						<Collapsible open={queuedMessages.length > 0} className="relative z-20 overflow-visible">
							{queuedMessages.length > 0 && (
								<QueuedSteeringStrip
									messages={queuedMessages}
									currentUserId={currentUserId}
									sessionParticipants={sessionParticipants}
									localOnlyMessageIds={localOnlyMessageIds}
									onRemoveMessage={handleRemoveQueuedMessage}
								/>
							)}
						</Collapsible>
						<div
							className={cn(
								`
									relative overflow-hidden rounded-lg border bg-bg-primary
									transition-colors
								`,
								'focus-within:border-accent',
								isDraggingImage ? 'border-accent' : isProcessing ? 'border-warning/40' : 'border-border',
							)}
							onDragOver={handleInputDragOver}
							onDragEnter={handleInputDragOver}
							onDragLeave={handleInputDragLeave}
							onDrop={handleInputDrop}
						>
							{isDraggingImage && (
								<div
									className="
										pointer-events-none absolute inset-0 z-30 flex items-center
										justify-center rounded-lg border-2 border-dashed border-accent
										bg-accent/10 text-xs font-medium text-accent
									"
								>
									Drop images to attach
								</div>
							)}
							<InputInfoBar open={!isConnected} icon={<Spinner className="size-3 shrink-0 text-warning" />}>
								<span className="flex-1 text-xs text-text-secondary">
									{agentConnectionState === 'connecting' ? 'Connecting to agent…' : 'Connection lost. Reconnecting…'}
								</span>
							</InputInfoBar>

							<ImageAttachmentStrip attachments={imageAttachments} onRemoveAttachment={removeImageAttachment} />

							<RichTextInput
								ref={inputReference}
								segments={visibleInputSegments}
								onSegmentsChange={setSegments}
								onKeyDown={handleKeyDown}
								onCursorChange={setCursorPosition}
								onPasteFiles={addImageFiles}
								disabled={speechToText.isRecording}
								inlineSuffix={speechToText.isRecording ? <BouncingDots className="ml-1 text-text-secondary" /> : undefined}
								placeholder={inputPlaceholder}
							/>
							<Collapsible open={!!planPath}>
								{planPath && (
									<button
										onClick={() => openFile(planPath)}
										className="
											flex w-full items-center gap-1.5 border-t border-border/50 px-2.5
											py-1 text-xs text-accent transition-colors
											hover:bg-accent/5
										"
									>
										<MapIcon className="size-3 shrink-0" />
										<span className="truncate">View plan: {planPath.split('/').pop()}</span>
									</button>
								)}
							</Collapsible>
							<ComposerControls
								speechToText={speechToText}
								agentMode={agentMode}
								setAgentMode={setAgentMode}
								selectedModel={selectedModel}
								setSelectedModel={setSelectedModel}
								contextTokensUsed={contextTokensUsed}
								imageAttachmentCount={imageAttachments.length}
								addImageFiles={addImageFiles}
								onStopRecording={handleStopRecording}
								onMicrophoneClick={handleMicrophoneClick}
								onSubmit={() => void handleSubmit()}
								isConnected={isConnected}
								isProcessing={isProcessing}
								canSubmit={canSubmit}
							/>
						</div>
					</div>
				</div>
			</div>

			{pendingRevert && (
				<RevertConfirmDialog
					open={!!pendingRevert}
					onOpenChange={(open) => {
						if (!open && !pendingRevert.isLoading) setPendingRevert(undefined);
					}}
					snapshotIds={pendingRevert.snapshotIds}
					messageIndex={pendingRevert.messageIndex}
					projectId={projectId}
					onConfirm={handleConfirmRevert}
					isReverting={pendingRevert.isLoading}
					revertError={pendingRevert.error}
				/>
			)}
		</div>
	);
}
