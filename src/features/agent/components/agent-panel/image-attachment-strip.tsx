import { X } from 'lucide-react';

import { Spinner } from '@/components/ui/spinner';

import type { ImageAttachment } from '../agent-runtime-context';

export function ImageAttachmentStrip({
	attachments,
	onRemoveAttachment,
}: {
	attachments: ImageAttachment[];
	onRemoveAttachment: (id: string) => void;
}) {
	return (
		<>
			{attachments.length > 0 && (
				<div className="flex flex-wrap gap-1.5 px-2 pt-2" data-testid="agent-image-attachments">
					{attachments.map((attachment) => (
						<div
							key={attachment.id}
							className="
								group relative size-14 overflow-hidden rounded-md border border-border
								bg-bg-secondary
							"
						>
							<img src={attachment.previewUrl} alt={attachment.name} className="size-full object-cover" />
							{attachment.status === 'uploading' && (
								<div
									className="
										absolute inset-0 flex items-center justify-center bg-bg-primary/60
									"
								>
									<Spinner className="size-4 text-accent" />
								</div>
							)}
							{attachment.status === 'error' && (
								<div
									className="
										absolute inset-0 flex items-center justify-center bg-error/20
										text-[10px] font-medium text-error
									"
								>
									Failed
								</div>
							)}
							<button
								type="button"
								onClick={() => onRemoveAttachment(attachment.id)}
								className="
									absolute top-0.5 right-0.5 inline-flex items-center justify-center
									rounded-full bg-bg-primary/80 p-0.5 text-text-secondary
									transition-colors
									hover:bg-bg-primary hover:text-text-primary
								"
								aria-label={`Remove ${attachment.name}`}
							>
								<X className="size-3" />
							</button>
						</div>
					))}
				</div>
			)}
		</>
	);
}
