import { useFileTree as useTreesModel } from '@pierre/trees/react';
import { FilePlus, FolderPlus, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/utils';
import { PROTECTED_FILES } from '@shared/constants';

import { toStorePath } from './file-tree-model';

import type { ContextMenuItem, ContextMenuOpenContext } from '@pierre/trees';

interface FileTreeContextMenuProperties {
	item: ContextMenuItem;
	context: ContextMenuOpenContext;
	model: ReturnType<typeof useTreesModel>['model'];
	onCreateFile?: (path: string) => void;
	onCreateFolder?: (path: string) => void;
	onDeleteFile?: (path: string) => void;
	allowRename: boolean;
}

function FileTreeContextMenu({
	item,
	context,
	model,
	onCreateFile,
	onCreateFolder,
	onDeleteFile,
	allowRename,
}: FileTreeContextMenuProperties) {
	const storePath = toStorePath(item.path);
	const isProtected = PROTECTED_FILES.has(storePath);
	const directory = item.kind === 'directory' ? item.path.replace(/\/$/, '') : item.path.split('/').slice(0, -1).join('/');
	const menuReference = useRef<HTMLDivElement>(null);

	// The library's outside-click dismissal does not catch panel resize-handle
	// drags (their pointer capture swallows the event) or scrolling, which would
	// leave the fixed-position menu stranded. Close it on any outside pointer
	// press, scroll, or window resize.
	useEffect(() => {
		const closeOnOutsidePointer = (event: Event) => {
			const target = event.target instanceof Node ? event.target : undefined;
			if (target && menuReference.current?.contains(target)) return;
			context.close();
		};
		const close = () => context.close();
		document.addEventListener('mousedown', closeOnOutsidePointer, true);
		document.addEventListener('pointerdown', closeOnOutsidePointer, true);
		globalThis.addEventListener('resize', close);
		globalThis.addEventListener('scroll', close, true);
		return () => {
			document.removeEventListener('mousedown', closeOnOutsidePointer, true);
			document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
			globalThis.removeEventListener('resize', close);
			globalThis.removeEventListener('scroll', close, true);
		};
	}, [context]);

	const promptCreate = (kind: 'file' | 'folder') => {
		context.close({ restoreFocus: false });
		const name = globalThis.prompt(`New ${kind} name`, '');
		if (!name?.trim()) return;
		const treePath = directory ? `${directory}/${name.trim()}` : name.trim();
		const target = toStorePath(treePath);
		if (kind === 'file') onCreateFile?.(target);
		else onCreateFolder?.(target);
	};

	// Render into a body-level portal so the menu escapes the file-tree panel's
	// `overflow-hidden` clipping and stacks above the resizable-panel drag
	// handles. `data-file-tree-context-menu-root` keeps internal clicks from
	// being treated as outside clicks by the library's dismiss logic.
	return createPortal(
		<div
			ref={menuReference}
			role="menu"
			data-file-tree-context-menu-root="true"
			style={{
				position: 'fixed',
				top: context.anchorRect.bottom,
				left: Math.min(context.anchorRect.left, globalThis.innerWidth - 176),
				zIndex: 9999,
			}}
			className={cn(`
				min-w-40 rounded-md border border-border bg-bg-secondary p-1 text-sm
				shadow-lg
			`)}
		>
			{allowRename && item.kind === 'file' && !isProtected && (
				<MenuItem
					label="Rename"
					icon={<Pencil className="size-3.5" />}
					onClick={() => {
						context.close({ restoreFocus: false });
						model.startRenaming(item.path);
					}}
				/>
			)}
			{onCreateFile && <MenuItem label="New file" icon={<FilePlus className="size-3.5" />} onClick={() => promptCreate('file')} />}
			{onCreateFolder && <MenuItem label="New folder" icon={<FolderPlus className="size-3.5" />} onClick={() => promptCreate('folder')} />}
			{onDeleteFile && !isProtected && (
				<MenuItem
					label="Delete"
					destructive
					icon={<Trash2 className="size-3.5" />}
					onClick={() => {
						context.close();
						onDeleteFile(storePath);
					}}
				/>
			)}
		</div>,
		document.body,
	);
}

function MenuItem({
	label,
	icon,
	onClick,
	destructive,
}: {
	label: string;
	icon: React.ReactNode;
	onClick: () => void;
	destructive?: boolean;
}) {
	return (
		<button
			type="button"
			role="menuitem"
			onClick={onClick}
			className={cn(
				`
					flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5
					text-left
				`,
				'hover:bg-bg-tertiary',
				destructive ? 'text-error' : 'text-text-primary',
			)}
		>
			{icon}
			<span>{label}</span>
		</button>
	);
}

export { FileTreeContextMenu };
