import { Check, LoaderCircle, MessageSquare, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { useState } from 'react';

import { toast } from '@/components/ui/toast-store';
import { cn } from '@/lib/utils';

import type { SessionSummary } from '@shared/agent-state';

export function AgentSessionList({
	sessions,
	selectedId,
	query,
	onQuery,
	onSelect,
	onNew,
	onRename,
	onDelete,
}: {
	sessions: SessionSummary[];
	selectedId?: string;
	query: string;
	onQuery: (query: string) => void;
	onSelect: (id: string) => void;
	onNew: () => void;
	onRename: (id: string, title: string) => Promise<void>;
	onDelete: (id: string) => Promise<void>;
}) {
	const [editing, setEditing] = useState<string | undefined>();
	const [title, setTitle] = useState('');
	const [deleting, setDeleting] = useState<string | undefined>();
	const [busy, setBusy] = useState(false);
	async function rename(id: string) {
		setBusy(true);
		try {
			await onRename(id, title);
			setEditing(undefined);
		} catch (error) {
			toast.error(String(error));
		} finally {
			setBusy(false);
		}
	}
	async function remove(id: string) {
		setBusy(true);
		try {
			await onDelete(id);
			setDeleting(undefined);
		} catch (error) {
			toast.error(String(error));
		} finally {
			setBusy(false);
		}
	}
	return (
		<section aria-label="Agent sessions" className="border-b border-border bg-bg-primary/60">
			<div className="flex items-center gap-2 px-3 py-2">
				<Search className="size-3.5 text-text-secondary" aria-hidden />
				<input
					id="agent-session-search"
					aria-label="Search sessions"
					value={query}
					onChange={(event) => onQuery(event.target.value)}
					placeholder="Search sessions"
					className="
						min-w-0 flex-1 bg-transparent text-xs outline-none
						focus-visible:ring-2 focus-visible:ring-accent
					"
				/>
				<button
					id="agent-new-session"
					type="button"
					onClick={onNew}
					className="
						rounded-sm p-1 text-accent
						hover:bg-accent/10
						focus-visible:ring-2 focus-visible:ring-accent
					"
					aria-label="New session"
				>
					<Plus className="size-4" />
				</button>
			</div>
			<div className="max-h-44 overflow-y-auto px-1 pb-1">
				{sessions.map((session) => (
					<div
						key={session.id}
						className={cn('group flex items-center gap-1 rounded-md px-2 py-1', selectedId === session.id && 'bg-accent/10')}
					>
						{session.isRunning ? (
							<LoaderCircle className="size-3.5 shrink-0 animate-spin text-accent" aria-label="Running" />
						) : (
							<MessageSquare className="size-3.5 shrink-0 text-text-secondary" aria-hidden />
						)}
						{editing === session.id ? (
							<form
								className="flex min-w-0 flex-1 gap-1"
								onSubmit={(event) => {
									event.preventDefault();
									void rename(session.id);
								}}
							>
								<input
									id={`agent-title-${session.id}`}
									aria-label="Session title"
									value={title}
									onChange={(event) => setTitle(event.target.value)}
									maxLength={100}
									className="
										min-w-0 flex-1 border-b border-accent bg-transparent text-xs
										outline-none
									"
									autoFocus
									onKeyDown={(event) => {
										if (event.key === 'Escape') setEditing(undefined);
									}}
								/>
								<button id={`agent-save-title-${session.id}`} aria-label="Save session title" disabled={busy} className="text-accent">
									<Check className="size-4" />
								</button>
							</form>
						) : (
							<button
								id={`agent-select-${session.id}`}
								type="button"
								onClick={() => onSelect(session.id)}
								aria-current={selectedId === session.id ? 'page' : undefined}
								className="
									min-w-0 flex-1 truncate rounded-sm p-1 text-left text-xs
									focus-visible:ring-2 focus-visible:ring-accent
								"
							>
								{session.title}
							</button>
						)}
						{deleting === session.id ? (
							<div className="flex gap-1" role="group" aria-label={`Delete ${session.title}?`}>
								<button
									id={`agent-confirm-delete-${session.id}`}
									onClick={() => void remove(session.id)}
									disabled={busy}
									className="
										rounded-sm px-1 text-xs text-error
										focus-visible:ring-2 focus-visible:ring-accent
									"
								>
									Delete
								</button>
								<button
									id={`agent-cancel-delete-${session.id}`}
									onClick={() => setDeleting(undefined)}
									aria-label="Cancel deletion"
									className="
										rounded-sm
										focus-visible:ring-2 focus-visible:ring-accent
									"
								>
									<X className="size-3.5" />
								</button>
							</div>
						) : (
							<>
								<button
									id={`agent-rename-${session.id}`}
									onClick={() => {
										setEditing(session.id);
										setTitle(session.title);
									}}
									aria-label={`Rename ${session.title}`}
									className="
										rounded-sm p-1 text-text-secondary
										hover:text-text-primary
										focus-visible:ring-2 focus-visible:ring-accent
									"
								>
									<Pencil className="size-3" />
								</button>
								<button
									id={`agent-delete-${session.id}`}
									onClick={() => setDeleting(session.id)}
									aria-label={`Delete ${session.title}`}
									className="
										rounded-sm p-1 text-text-secondary
										hover:text-error
										focus-visible:ring-2 focus-visible:ring-accent
									"
								>
									<Trash2 className="size-3" />
								</button>
							</>
						)}
					</div>
				))}
				{sessions.length === 0 && <p className="p-3 text-xs text-text-secondary">{query ? 'No sessions found.' : 'No sessions yet.'}</p>}
			</div>
		</section>
	);
}
