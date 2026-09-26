import { prepareFileTreeInput, type ContextMenuItem, type ContextMenuOpenContext } from '@pierre/trees';
import { FileTree as TreesFileTree, useFileTree as useTreesModel } from '@pierre/trees/react';
import { FilePlus, FolderPlus } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useSyncExternalStore } from 'react';

import { cn } from '@/lib/utils';

import { FileTreeContextMenu } from './file-tree-context-menu';
import { buildGitStatus, buildPresence, isProtectedTreePath, toStorePath, toTreePath, type PresenceIcon } from './file-tree-model';

import type { FileInfo, GitFileStatus, Participant } from '@shared/types';

export interface FileTreeProperties {
	files: FileInfo[];
	selectedFile: string | undefined;
	expandedDirectories: Set<string>;
	onFileSelect: (path: string) => void;
	onDirectoryToggle: (path: string) => void;
	onCreateFile?: (path: string) => void;
	onDeleteFile?: (path: string) => void;
	onRenameFile?: (fromPath: string, toPath: string) => void;
	onCreateFolder?: (path: string) => void;
	onMoveFile?: (fromPath: string, toPath: string) => void;
	participants?: Participant[];
	gitStatusMap?: Map<string, GitFileStatus>;
	className?: string;
}

// Host styling owns layout (width/height); everything inside the tree is driven
// by the library's --trees-theme-* variable surface. We only map our design
// tokens onto those theme variables and otherwise rely on the library defaults.
const TREE_THEME_STYLE: Record<string, string> = {
	height: '100%',
	'--trees-theme-sidebar-bg': 'var(--color-bg-secondary)',
	// The truncation marker (the "…") paints a small background chip over the
	// clipped edge of the name. It defaults to light-dark(white, black); match it
	// to the row background so the ellipsis masks the text instead of overlaying it.
	'--truncate-marker-background-color': 'var(--color-bg-secondary)',
	'--trees-theme-sidebar-fg': 'var(--color-text-secondary)',
	'--trees-theme-sidebar-border': 'var(--color-border)',
	'--trees-theme-sidebar-header-fg': 'var(--color-text-secondary)',
	'--trees-theme-list-hover-bg': 'var(--color-bg-tertiary)',
	'--trees-theme-list-active-selection-bg': 'color-mix(in oklab, var(--color-accent) 15%, transparent)',
	'--trees-theme-list-active-selection-fg': 'var(--color-accent)',
	'--trees-theme-focus-ring': 'var(--color-accent)',
	'--trees-theme-input-bg': 'var(--color-bg-primary)',
	'--trees-theme-input-border': 'var(--color-border)',
	'--trees-theme-input-fg': 'var(--color-text-primary)',
	'--trees-theme-scrollbar-thumb': 'var(--color-border-solid)',
	'--trees-theme-git-modified-fg': 'var(--color-collab-cyan)',
	'--trees-theme-git-added-fg': 'var(--color-success)',
	'--trees-theme-git-untracked-fg': 'var(--color-success)',
	'--trees-theme-git-renamed-fg': 'var(--color-collab-cyan)',
	'--trees-theme-git-deleted-fg': 'var(--color-error)',
	'--trees-theme-git-ignored-fg': 'var(--color-text-secondary)',
};

const FINE_POINTER_MEDIA_QUERY = '(hover: hover) and (pointer: fine)';

function getFinePointerMediaQueryList(): MediaQueryList | undefined {
	if (typeof globalThis.matchMedia !== 'function') return undefined;
	return globalThis.matchMedia(FINE_POINTER_MEDIA_QUERY);
}

function subscribeToFinePointer(callback: () => void): () => void {
	const mediaQueryList = getFinePointerMediaQueryList();
	if (!mediaQueryList) return () => {};
	mediaQueryList.addEventListener('change', callback);
	return () => mediaQueryList.removeEventListener('change', callback);
}

function getFinePointerSnapshot(): boolean {
	return getFinePointerMediaQueryList()?.matches ?? false;
}

function getFinePointerServerSnapshot(): boolean {
	return false;
}

// Bring the model selection in line with the externally-opened file. The model
// is the source of truth for the tree highlight, so we deselect any stray paths
// and select the open file. Scrolling is opt-in because revealing the row is
// only wanted for genuine navigation, not for background re-syncs (e.g. while a
// drag is in progress).
function syncModelSelection(
	model: ReturnType<typeof useTreesModel>['model'],
	selectedFile: string | undefined,
	options: { scroll: boolean },
): void {
	const treePath = selectedFile?.replace(/^\/+/, '');
	for (const path of model.getSelectedPaths()) {
		if (path !== treePath) model.getItem(path)?.deselect();
	}
	if (!treePath) return;
	if (model.getSelectedPaths().includes(treePath)) return;
	const item = model.getItem(treePath);
	if (!item) return;
	item.select();
	if (options.scroll) model.scrollToPath(treePath, { offset: 'nearest' });
}

export function FileTree(properties: FileTreeProperties) {
	const hasFinePointer = useSyncExternalStore(subscribeToFinePointer, getFinePointerSnapshot, getFinePointerServerSnapshot);
	const contextMenuButtonVisibility = hasFinePointer ? 'when-needed' : 'always';

	return (
		<FileTreeContent
			key={contextMenuButtonVisibility}
			{...properties}
			hasFinePointer={hasFinePointer}
			contextMenuButtonVisibility={contextMenuButtonVisibility}
		/>
	);
}

function FileTreeContent({
	files,
	selectedFile,
	expandedDirectories,
	onFileSelect,
	onDirectoryToggle,
	onCreateFile,
	onDeleteFile,
	onRenameFile,
	onCreateFolder,
	onMoveFile,
	participants = [],
	gitStatusMap,
	className,
	hasFinePointer,
	contextMenuButtonVisibility,
}: FileTreeProperties & { hasFinePointer: boolean; contextMenuButtonVisibility: 'always' | 'when-needed' }) {
	const treeLabelId = useId();

	// Stable references so option callbacks always see the latest props without
	// recreating the (intentionally one-shot) tree model.
	const callbacks = useRef({ onFileSelect, onDirectoryToggle, onRenameFile, onMoveFile });
	useEffect(() => {
		callbacks.current = { onFileSelect, onDirectoryToggle, onRenameFile, onMoveFile };
	}, [onFileSelect, onDirectoryToggle, onRenameFile, onMoveFile]);

	// Picking a file up for drag (long-press on touch, or native drag start)
	// changes the model selection, which would otherwise be treated as "open
	// this file". canDrag runs synchronously inside the same startDrag() call
	// that emits the selection change, so this flag is always set immediately
	// before onSelectionChange consumes it.
	const selectionFromDragPickupReference = useRef(false);

	// Selection changes we drive ourselves (keeping the model in sync with the
	// open file) must never be reported back as "open this file".
	const isProgrammaticSelectionReference = useRef(false);
	const selectedFileReference = useRef(selectedFile);
	const modelReference = useRef<ReturnType<typeof useTreesModel>['model'] | undefined>(undefined);

	const runProgrammaticSelection = useCallback((run: () => void) => {
		isProgrammaticSelectionReference.current = true;
		try {
			run();
		} finally {
			isProgrammaticSelectionReference.current = false;
		}
	}, []);

	// The library has no expansion-change event, so we detect user expand/collapse
	// by diffing the model in a subscription (below). Model mutations we drive
	// ourselves (reconciling the model with the store, resetting paths) must not
	// be reported back as user toggles, so they run behind this guard.
	const isProgrammaticExpansionReference = useRef(false);
	const runProgrammaticExpansion = useCallback((run: () => void) => {
		isProgrammaticExpansionReference.current = true;
		try {
			run();
		} finally {
			isProgrammaticExpansionReference.current = false;
		}
	}, []);

	// Latest values for the (one-shot) model subscription, which is created once
	// and must read fresh props without being torn down on every change.
	const filesReference = useRef(files);
	const expandedDirectoriesReference = useRef(expandedDirectories);
	useEffect(() => {
		filesReference.current = files;
	}, [files]);
	useEffect(() => {
		expandedDirectoriesReference.current = expandedDirectories;
	}, [expandedDirectories]);

	// renderRowDecoration is captured once at model creation, so it reads the
	// per-file presence icons from a ref. The presence effect below rebuilds the
	// sprite + lookup and re-renders the rows whenever participants change.
	const presenceReference = useRef<Map<string, PresenceIcon>>(new Map());

	const initialPaths = useMemo(() => files.map((file) => toTreePath(file.path, file.isDirectory)), []); // eslint-disable-line react-hooks/exhaustive-deps
	const preparedInput = useMemo(() => prepareFileTreeInput(initialPaths), [initialPaths]);

	const initialExpandedPaths = useMemo(
		() =>
			[...expandedDirectories].map((path) => {
				const stripped = path.replace(/^\/+/, '');
				return `${stripped}/`;
			}),
		[], // eslint-disable-line react-hooks/exhaustive-deps
	);

	const initialSelectedPaths = useMemo(() => (selectedFile ? [selectedFile.replace(/^\/+/, '')] : []), []); // eslint-disable-line react-hooks/exhaustive-deps
	const appliedPathsKeyReference = useRef(initialPaths.join('\u0000'));
	const appliedExpandedPathsKeyReference = useRef(initialExpandedPaths.join('\u0000'));

	const { model } = useTreesModel({
		preparedInput,
		// Directories are collapsed by default (VS Code style); the store-driven
		// expandedDirectories restores the folders the user previously opened.
		initialExpandedPaths,
		initialSelectedPaths,
		search: true,
		fileTreeSearchMode: 'hide-non-matches',
		density: 'compact',
		icons: 'standard',
		stickyFolders: true,
		composition: {
			contextMenu: { enabled: true, triggerMode: 'both', buttonVisibility: contextMenuButtonVisibility },
		},
		gitStatus: buildGitStatus(files, gitStatusMap),
		onSelectionChange: (selectedPaths) => {
			if (isProgrammaticSelectionReference.current) return;
			if (selectionFromDragPickupReference.current) {
				selectionFromDragPickupReference.current = false;
				// A drag pickup forces the model selection onto the dragged row.
				// Restore it to the open file (after this emit, to avoid re-entrant
				// selection mutations) so the highlight keeps matching the editor and
				// a later click on the dragged row still emits a selection change.
				globalThis.queueMicrotask(() => {
					const model = modelReference.current;
					if (!model) return;
					runProgrammaticSelection(() => syncModelSelection(model, selectedFileReference.current, { scroll: false }));
				});
				return;
			}
			const path = selectedPaths.at(-1);
			if (!path || path.endsWith('/')) return;
			callbacks.current.onFileSelect(toStorePath(path));
		},
		renaming: onRenameFile
			? {
					canRename: (item) => !isProtectedTreePath(item.path),
					onRename: ({ sourcePath, destinationPath }) => {
						callbacks.current.onRenameFile?.(toStorePath(sourcePath), toStorePath(destinationPath));
					},
				}
			: undefined,
		dragAndDrop: onMoveFile
			? {
					canDrag: (paths) => {
						if (!paths.every((path) => !isProtectedTreePath(path))) return false;
						// A drag pickup will emit a selection change; mark it so
						// onSelectionChange does not treat it as opening the file.
						selectionFromDragPickupReference.current = true;
						// Confirm the pickup with a short haptic pulse on touch devices.
						if (!hasFinePointer) globalThis.navigator?.vibrate?.(15);
						return true;
					},
					onDropComplete: ({ draggedPaths, target }) => {
						const directory = target.directoryPath;
						for (const dragged of draggedPaths) {
							const trimmed = dragged.endsWith('/') ? dragged.slice(0, -1) : dragged;
							const name = trimmed.split('/').pop();
							if (!name) continue;
							const destination = directory ? `${directory.replace(/\/$/, '')}/${name}` : name;
							if (destination === trimmed) continue;
							callbacks.current.onMoveFile?.(toStorePath(trimmed), toStorePath(destination));
						}
					},
				}
			: undefined,

		renderRowDecoration: ({ item }) => {
			// eslint-disable-next-line unicorn/no-null -- external API contract.
			if (item.kind === 'directory') return null;
			const presence = presenceReference.current.get(toStorePath(item.path));
			// eslint-disable-next-line unicorn/no-null -- external API contract.
			if (!presence) return null;
			return {
				icon: { name: presence.name, width: presence.width, height: presence.height, viewBox: presence.viewBox },
				title: `${presence.count} collaborator${presence.count === 1 ? '' : 's'} editing`,
			};
		},
	});

	// Reflect store-driven expansion in the model: restore persisted expansions
	// and reveal directories opened externally (e.g. revealing a file). Folders
	// are collapsed by default, so this only ever expands.
	useEffect(() => {
		runProgrammaticExpansion(() => {
			for (const path of expandedDirectories) {
				const directory = model.getItem(`${path.replace(/^\/+/, '')}/`);
				if (directory && 'expand' in directory && !directory.isExpanded()) {
					directory.expand();
				}
			}
		});
	}, [expandedDirectories, model, runProgrammaticExpansion]);

	// Persist user expand/collapse. The library exposes no expansion event, so we
	// diff every known directory's model state against the store on each change
	// and report genuine (non-programmatic) differences as toggles.
	useEffect(() => {
		return model.subscribe(() => {
			if (isProgrammaticExpansionReference.current) return;
			const expanded = expandedDirectoriesReference.current;
			for (const file of filesReference.current) {
				if (!file.isDirectory) continue;
				const directory = model.getItem(toTreePath(file.path, true));
				if (!directory || !('isExpanded' in directory)) continue;
				if (directory.isExpanded() !== expanded.has(file.path)) {
					callbacks.current.onDirectoryToggle(file.path);
				}
			}
		});
	}, [model]);

	// Expose the model and latest open file to the (one-shot) option callbacks,
	// which are created before the model exists and must read fresh values.
	useEffect(() => {
		modelReference.current = model;
	}, [model]);
	useEffect(() => {
		selectedFileReference.current = selectedFile;
	}, [selectedFile]);

	// Keep the model selection in sync with externally-driven file selection
	// (e.g. switching tabs, agent navigation). Deselect any stale paths so the
	// tree highlight always matches the currently opened file.
	useEffect(() => {
		runProgrammaticSelection(() => syncModelSelection(model, selectedFile, { scroll: true }));
	}, [selectedFile, model, runProgrammaticSelection]);

	// Rebuild the tree paths whenever the underlying file list changes. Skip the
	// initial render since the model already mounts with the prepared input and
	// the configured initial expansion.
	useEffect(() => {
		const paths = files.map((file) => toTreePath(file.path, file.isDirectory));
		const expanded = [...expandedDirectories].map((path) => `${path.replace(/^\/+/, '')}/`);
		const pathsKey = paths.join('\u0000');
		const expandedPathsKey = expanded.join('\u0000');

		if (appliedPathsKeyReference.current === pathsKey && appliedExpandedPathsKeyReference.current === expandedPathsKey) {
			return;
		}

		appliedPathsKeyReference.current = pathsKey;
		appliedExpandedPathsKeyReference.current = expandedPathsKey;
		runProgrammaticExpansion(() => model.resetPaths(paths, { initialExpandedPaths: expanded }));
	}, [files, expandedDirectories, model, runProgrammaticExpansion]);

	// Push git status updates into the model.
	useEffect(() => {
		model.setGitStatus(buildGitStatus(files, gitStatusMap));
	}, [files, gitStatusMap, model]);

	// Rebuild collaborator presence dots when participants change. setIcons swaps
	// in the synthesized sprite and re-renders all rows, so the frozen
	// renderRowDecoration picks up the refreshed per-file lookup from the ref.
	useEffect(() => {
		const { spriteSheet, byFile } = buildPresence(participants);
		presenceReference.current = byFile;
		model.setIcons({ set: 'standard', spriteSheet });
	}, [participants, model]);

	const focusedDirectoryPath = useCallback(() => {
		const focused = model.getFocusedPath() ?? model.getSelectedPaths().at(-1);
		if (!focused) return '';
		if (focused.endsWith('/')) return focused.replace(/\/$/, '');
		const segments = focused.split('/');
		segments.pop();
		return segments.join('/');
	}, [model]);

	const handleCreateFile = useCallback(() => {
		if (!onCreateFile) return;
		const directory = focusedDirectoryPath();
		const name = globalThis.prompt('New file name', '');
		if (!name?.trim()) return;
		const treePath = directory ? `${directory}/${name.trim()}` : name.trim();
		onCreateFile(toStorePath(treePath));
	}, [focusedDirectoryPath, onCreateFile]);

	const handleCreateFolder = useCallback(() => {
		if (!onCreateFolder) return;
		const directory = focusedDirectoryPath();
		const name = globalThis.prompt('New folder name', '');
		if (!name?.trim()) return;
		const treePath = directory ? `${directory}/${name.trim()}` : name.trim();
		onCreateFolder(toStorePath(treePath));
	}, [focusedDirectoryPath, onCreateFolder]);

	const renderContextMenu = useCallback(
		(item: ContextMenuItem, context: ContextMenuOpenContext) => (
			<FileTreeContextMenu
				item={item}
				context={context}
				model={model}
				onCreateFile={onCreateFile}
				onCreateFolder={onCreateFolder}
				onDeleteFile={onDeleteFile}
				allowRename={Boolean(onRenameFile)}
			/>
		),
		[model, onCreateFile, onCreateFolder, onDeleteFile, onRenameFile],
	);

	return (
		<div className={cn('flex h-full flex-col', className)}>
			<TreesFileTree
				model={model}
				header={
					<div className="flex items-center justify-between px-3 pt-1.5 pb-0.5">
						<span
							id={treeLabelId}
							className="
								text-xs font-semibold tracking-wider text-text-secondary uppercase
							"
						>
							Files
						</span>
						<div className="flex items-center gap-0.5">
							{onCreateFile && (
								<HeaderButton label="New file" onClick={handleCreateFile}>
									<FilePlus className="size-3.5" />
								</HeaderButton>
							)}
							{onCreateFolder && (
								<HeaderButton label="New folder" onClick={handleCreateFolder}>
									<FolderPlus className="size-3.5" />
								</HeaderButton>
							)}
						</div>
					</div>
				}
				renderContextMenu={renderContextMenu}
				aria-labelledby={treeLabelId}
				className="min-h-0 flex-1"
				style={TREE_THEME_STYLE}
			/>
		</div>
	);
}

function HeaderButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={label}
			title={label}
			className={cn(
				`
					flex size-6 cursor-pointer items-center justify-center rounded-sm
					text-text-secondary
				`,
				`
					transition-colors
					hover:bg-bg-tertiary hover:text-text-primary
				`,
			)}
		>
			{children}
		</button>
	);
}
