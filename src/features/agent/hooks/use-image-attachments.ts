import { useCallback, useMemo } from 'react';

import { toast } from '@/components/ui/toast-store';
import { optimizeImage } from '@/lib/api-client';
import { ACCEPTED_IMAGE_MEDIA_TYPES, MAX_IMAGE_ATTACHMENTS, MAX_IMAGE_UPLOAD_BYTES } from '@shared/constants';

import { useAgentRuntime, type ImageAttachment } from '../components/agent-runtime-context';

import type { UserMessagePart } from '@shared/types';

const MAX_IMAGE_UPLOAD_MB = Math.round(MAX_IMAGE_UPLOAD_BYTES / (1024 * 1024));

export interface UseImageAttachmentsResult {
	attachments: ImageAttachment[];
	addFiles: (files: File[]) => void;
	removeAttachment: (id: string) => void;
	clearAttachments: () => void;
	hasUploading: boolean;
	readyImageParts: UserMessagePart[];
}

/**
 * Manages transient image attachments for the agent input: validation,
 * server-side optimization (Cloudflare Images), and conversion to message parts.
 */
export function useImageAttachments(projectId: string): UseImageAttachmentsResult {
	const { imageAttachments, setImageAttachments } = useAgentRuntime();

	const addFiles = useCallback(
		(files: File[]) => {
			const slotsLeft = MAX_IMAGE_ATTACHMENTS - imageAttachments.length;
			if (slotsLeft <= 0) {
				toast.error(`You can attach up to ${MAX_IMAGE_ATTACHMENTS} images.`);
				return;
			}

			const accepted: File[] = [];
			for (const file of files) {
				if (accepted.length >= slotsLeft) {
					toast.error(`You can attach up to ${MAX_IMAGE_ATTACHMENTS} images.`);
					break;
				}
				if (!ACCEPTED_IMAGE_MEDIA_TYPES.includes(file.type)) {
					toast.error(`Unsupported image type: ${file.name || file.type || 'unknown'}`);
					continue;
				}
				if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
					toast.error(`Image is too large (max ${MAX_IMAGE_UPLOAD_MB}MB): ${file.name}`);
					continue;
				}
				accepted.push(file);
			}

			if (accepted.length === 0) {
				return;
			}

			const newAttachments: ImageAttachment[] = accepted.map((file) => ({
				id: crypto.randomUUID(),
				name: file.name || 'image',
				status: 'uploading',
				previewUrl: URL.createObjectURL(file),
			}));
			setImageAttachments((current) => [...current, ...newAttachments]);

			for (const [index, attachment] of newAttachments.entries()) {
				const file = accepted[index];
				optimizeImage(projectId, file)
					.then((result) => {
						setImageAttachments((current) =>
							current.map((item) =>
								item.id === attachment.id ? { ...item, status: 'ready', url: result.url, mediaType: result.mediaType } : item,
							),
						);
					})
					.catch((error: unknown) => {
						console.error('[useImageAttachments] Failed to optimize image:', error);
						toast.error(`Failed to process image: ${file.name}`);
						setImageAttachments((current) =>
							current.map((item) => (item.id === attachment.id ? { ...item, status: 'error', error: 'Failed to process' } : item)),
						);
					});
			}
		},
		[imageAttachments.length, projectId, setImageAttachments],
	);

	const removeAttachment = useCallback(
		(id: string) => {
			setImageAttachments((current) => {
				const target = current.find((item) => item.id === id);
				if (target) {
					URL.revokeObjectURL(target.previewUrl);
				}
				return current.filter((item) => item.id !== id);
			});
		},
		[setImageAttachments],
	);

	const clearAttachments = useCallback(() => {
		const sentIds = new Set(imageAttachments.map((attachment) => attachment.id));
		setImageAttachments((current) => {
			for (const item of current.filter((attachment) => sentIds.has(attachment.id))) {
				URL.revokeObjectURL(item.previewUrl);
			}
			return current.filter((attachment) => !sentIds.has(attachment.id));
		});
	}, [imageAttachments, setImageAttachments]);

	const hasUploading = useMemo(() => imageAttachments.some((item) => item.status === 'uploading'), [imageAttachments]);

	const readyImageParts = useMemo<UserMessagePart[]>(
		() =>
			imageAttachments
				.filter((item) => item.status === 'ready' && item.url && item.mediaType)
				.map((item) => ({ type: 'image', url: item.url ?? '', mediaType: item.mediaType ?? '', name: item.name })),
		[imageAttachments],
	);

	return { attachments: imageAttachments, addFiles, removeAttachment, clearAttachments, hasUploading, readyImageParts };
}
