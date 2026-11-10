import { describe, expect, it, beforeEach } from 'vitest';

import { useStore } from './store';

// Reset store before each test
beforeEach(() => {
	useStore.setState({
		activeFile: undefined,
		openFiles: [],
		cursorPosition: undefined,
		unsavedChanges: new Map(),
		fileScrollPositions: new Map(),
		fileCursorPositions: new Map(),
		files: [],
		expandedDirs: new Set(),
		isLoading: false,
		pendingPreviewElementReferences: [],
		agentMode: 'code',
		participants: [],
		localParticipantId: undefined,
		localParticipantColor: undefined,
		isConnected: false,
		snapshots: [],
		activeSnapshot: undefined,
		pendingChanges: new Map(),
		sidebarVisible: true,
		utilityPanelVisible: true,
		agentPanelVisible: false,
		requestedAgentSessionId: undefined,
		devtoolsVisible: false,
		dependenciesPanelVisible: true,
		activeMobilePanel: 'editor',
		mobileFileTreeOpen: false,
		activeSidebarView: 'explorer',
		activeUtilityTab: 'output',
		gitDiffView: undefined,
	});
});

describe('Editor slice', () => {
	it('opens a file', () => {
		useStore.getState().openFile('/src/main.ts');

		const state = useStore.getState();
		expect(state.activeFile).toBe('/src/main.ts');
		expect(state.openFiles).toContain('/src/main.ts');
	});

	it('switches mobile to the editor when opening a file', () => {
		useStore.getState().setActiveMobilePanel('preview');

		useStore.getState().openFile('/src/main.ts');

		expect(useStore.getState().activeMobilePanel).toBe('editor');
	});

	it('does not duplicate open files', () => {
		useStore.getState().openFile('/src/main.ts');
		useStore.getState().openFile('/src/main.ts');

		expect(useStore.getState().openFiles).toHaveLength(1);
	});

	it('closes a file', () => {
		useStore.getState().openFile('/src/main.ts');
		useStore.getState().openFile('/src/app.tsx');
		useStore.getState().closeFile('/src/main.ts');

		const state = useStore.getState();
		expect(state.openFiles).not.toContain('/src/main.ts');
		expect(state.openFiles).toContain('/src/app.tsx');
	});

	it('sets active file to the tab on the right when closing the active tab', () => {
		useStore.getState().openFile('/src/a.ts');
		useStore.getState().openFile('/src/b.ts');
		useStore.getState().openFile('/src/c.ts');
		useStore.getState().setActiveFile('/src/b.ts');
		useStore.getState().closeFile('/src/b.ts');

		expect(useStore.getState().activeFile).toBe('/src/c.ts');
	});

	it('sets active file to the tab on the left when closing the active tab without a right neighbor', () => {
		useStore.getState().openFile('/src/a.ts');
		useStore.getState().openFile('/src/b.ts');
		useStore.getState().closeFile('/src/b.ts');

		expect(useStore.getState().activeFile).toBe('/src/a.ts');
	});

	it('sets active file to undefined when closing last file', () => {
		useStore.getState().openFile('/src/a.ts');
		useStore.getState().closeFile('/src/a.ts');

		expect(useStore.getState().activeFile).toBeUndefined();
	});

	it('clears the active file (tree selection) when closing all files', () => {
		useStore.getState().openFile('/src/a.ts');
		useStore.getState().openFile('/src/b.ts');

		useStore.getState().closeAllFiles();

		// activeFile is the single source of truth for the tree selection, so
		// closing every tab must leave nothing selected.
		expect(useStore.getState().activeFile).toBeUndefined();
		expect(useStore.getState().openFiles).toEqual([]);
	});

	it('sets cursor position', () => {
		useStore.getState().setCursorPosition({ line: 10, column: 5 });

		expect(useStore.getState().cursorPosition).toEqual({ line: 10, column: 5 });
	});

	it('switches mobile to the editor when navigating to a file position', () => {
		useStore.getState().setActiveMobilePanel('git');

		useStore.getState().goToFilePosition('/src/main.ts', { line: 10, column: 5 });

		const state = useStore.getState();
		expect(state.activeMobilePanel).toBe('editor');
		expect(state.activeFile).toBe('/src/main.ts');
		expect(state.pendingGoTo).toEqual({ line: 10, column: 5 });
	});

	it('marks file as changed', () => {
		useStore.getState().markFileChanged('/src/main.ts', true);

		expect(useStore.getState().unsavedChanges.get('/src/main.ts')).toBe(true);
	});

	it('closes all files', () => {
		useStore.getState().openFile('/src/a.ts');
		useStore.getState().openFile('/src/b.ts');
		useStore.getState().closeAllFiles();

		const state = useStore.getState();
		expect(state.openFiles).toHaveLength(0);
		expect(state.activeFile).toBeUndefined();
	});

	it('closes all files and clears per-file scroll positions', () => {
		useStore.getState().openFile('/src/a.ts');
		useStore.getState().setFileScrollPosition('/src/a.ts', 100);
		useStore.getState().closeAllFiles();

		expect(useStore.getState().fileScrollPositions.size).toBe(0);
	});

	it('sets per-file scroll position', () => {
		useStore.getState().setFileScrollPosition('/src/main.ts', 250);

		expect(useStore.getState().fileScrollPositions.get('/src/main.ts')).toBe(250);
	});

	it('cleans up per-file scroll position when closing a file', () => {
		useStore.getState().openFile('/src/main.ts');
		useStore.getState().setFileScrollPosition('/src/main.ts', 50);
		useStore.getState().closeFile('/src/main.ts');

		expect(useStore.getState().fileScrollPositions.has('/src/main.ts')).toBe(false);
	});

	it('bulk-restores per-file scroll positions', () => {
		const positions = new Map([
			['/src/a.ts', 0],
			['/src/b.ts', 300],
		]);
		useStore.getState().restoreFileScrollPositions(positions);

		expect(useStore.getState().fileScrollPositions).toEqual(positions);
	});

	it('sets per-file cursor position', () => {
		useStore.getState().setFileCursorPosition('/src/main.ts', { line: 10, column: 5 });

		expect(useStore.getState().fileCursorPositions.get('/src/main.ts')).toEqual({ line: 10, column: 5 });
	});

	it('cleans up per-file cursor position when closing a file', () => {
		useStore.getState().openFile('/src/main.ts');
		useStore.getState().setFileCursorPosition('/src/main.ts', { line: 3, column: 1 });
		useStore.getState().closeFile('/src/main.ts');

		expect(useStore.getState().fileCursorPositions.has('/src/main.ts')).toBe(false);
	});

	it('closes all files and clears per-file cursor positions', () => {
		useStore.getState().openFile('/src/a.ts');
		useStore.getState().setFileCursorPosition('/src/a.ts', { line: 5, column: 2 });
		useStore.getState().closeAllFiles();

		expect(useStore.getState().fileCursorPositions.size).toBe(0);
	});
});

describe('File Tree slice', () => {
	it('sets files', () => {
		const files = [
			{ path: '/src/main.ts', name: 'main.ts', isDirectory: false },
			{ path: '/src/app.tsx', name: 'app.tsx', isDirectory: false },
		];
		useStore.getState().setFiles(files);

		expect(useStore.getState().files).toHaveLength(2);
	});

	it('toggles directory expansion', () => {
		useStore.getState().toggleDirectory('/src');
		expect(useStore.getState().expandedDirs.has('/src')).toBe(true);

		useStore.getState().toggleDirectory('/src');
		expect(useStore.getState().expandedDirs.has('/src')).toBe(false);
	});

	it('expands a directory', () => {
		useStore.getState().expandDirectory('/src');
		expect(useStore.getState().expandedDirs.has('/src')).toBe(true);
	});

	it('collapses a directory', () => {
		useStore.getState().expandDirectory('/src');
		useStore.getState().collapseDirectory('/src');
		expect(useStore.getState().expandedDirs.has('/src')).toBe(false);
	});

	it('uses the active file as the tree selection source of truth', () => {
		useStore.getState().openFile('/src/main.ts');
		expect(useStore.getState().activeFile).toBe('/src/main.ts');
	});

	it('reveals a file by expanding its ancestor directories when opened', () => {
		useStore.getState().openFile('/src/components/ui/button.tsx');
		const expanded = useStore.getState().expandedDirs;
		expect(expanded.has('/src')).toBe(true);
		expect(expanded.has('/src/components')).toBe(true);
		expect(expanded.has('/src/components/ui')).toBe(true);
		// The file leaf itself is not a directory and must not be added.
		expect(expanded.has('/src/components/ui/button.tsx')).toBe(false);
	});

	it('reveals ancestor directories when navigating to a file position', () => {
		useStore.getState().goToFilePosition('/worker/routes/file-routes.ts', { line: 1, column: 1 });
		const expanded = useStore.getState().expandedDirs;
		expect(expanded.has('/worker')).toBe(true);
		expect(expanded.has('/worker/routes')).toBe(true);
	});

	it('keeps the same expandedDirs reference when opening a root-level file', () => {
		const before = useStore.getState().expandedDirs;
		useStore.getState().openFile('/readme.md');
		expect(useStore.getState().expandedDirs).toBe(before);
	});
});

describe('Agent preferences', () => {
	it('keeps default mode preferences without maintaining another transcript', () => {
		useStore.getState().setAgentMode('ask');
		expect(useStore.getState().agentMode).toBe('ask');
		expect(useStore.getState()).not.toHaveProperty('history');
	});
});

describe('Collaboration slice', () => {
	it('adds a participant', () => {
		useStore.getState().addParticipant({
			id: 'user1',
			color: '#f97316',
		});

		expect(useStore.getState().participants).toHaveLength(1);
	});

	it('removes a participant', () => {
		useStore.getState().addParticipant({
			id: 'user1',
			color: '#f97316',
		});
		useStore.getState().removeParticipant('user1');

		expect(useStore.getState().participants).toHaveLength(0);
	});

	it('sets connected state', () => {
		useStore.getState().setConnected(true);
		expect(useStore.getState().isConnected).toBe(true);
	});
});

describe('Pending Changes slice', () => {
	const sampleChange = {
		path: '/src/main.ts',
		action: 'edit' as const,
		beforeContent: 'old content',
		afterContent: 'new content',
		snapshotId: undefined,
		sessionId: 'test-session',
	};

	it('adds a pending change', () => {
		useStore.getState().addPendingChange(sampleChange);

		const change = useStore.getState().pendingChanges.get('/src/main.ts');
		expect(change).toBeDefined();
		expect(change?.status).toBe('pending');
		expect(change?.action).toBe('edit');
		expect(change?.hunkStatuses).toEqual([]);
	});

	it('deduplicates by keeping first beforeContent', () => {
		useStore.getState().addPendingChange(sampleChange);
		useStore.getState().addPendingChange({
			...sampleChange,
			beforeContent: 'intermediate content',
			afterContent: 'final content',
		});

		const change = useStore.getState().pendingChanges.get('/src/main.ts');
		expect(change?.beforeContent).toBe('old content');
		expect(change?.afterContent).toBe('final content');
	});

	it('approves a change', () => {
		useStore.getState().addPendingChange(sampleChange);
		useStore.getState().approveChange('/src/main.ts');

		expect(useStore.getState().pendingChanges.get('/src/main.ts')?.status).toBe('approved');
	});

	it('rejects a change', () => {
		useStore.getState().addPendingChange(sampleChange);
		useStore.getState().rejectChange('/src/main.ts');

		expect(useStore.getState().pendingChanges.get('/src/main.ts')?.status).toBe('rejected');
	});

	it('approves all pending changes', () => {
		useStore.getState().addPendingChange(sampleChange);
		useStore.getState().addPendingChange({ ...sampleChange, path: '/src/app.tsx' });
		useStore.getState().approveAllChanges();

		for (const change of useStore.getState().pendingChanges.values()) {
			expect(change.status).toBe('approved');
		}
	});

	it('rejects all pending changes', () => {
		useStore.getState().addPendingChange(sampleChange);
		useStore.getState().addPendingChange({ ...sampleChange, path: '/src/app.tsx' });
		useStore.getState().rejectAllChanges();

		for (const change of useStore.getState().pendingChanges.values()) {
			expect(change.status).toBe('rejected');
		}
	});

	it('does not change already-approved items when rejecting all', () => {
		useStore.getState().addPendingChange(sampleChange);
		useStore.getState().addPendingChange({ ...sampleChange, path: '/src/app.tsx' });
		useStore.getState().approveChange('/src/main.ts');
		useStore.getState().rejectAllChanges();

		expect(useStore.getState().pendingChanges.get('/src/main.ts')?.status).toBe('approved');
		expect(useStore.getState().pendingChanges.get('/src/app.tsx')?.status).toBe('rejected');
	});

	it('clears all pending changes', () => {
		useStore.getState().addPendingChange(sampleChange);
		useStore.getState().clearPendingChanges();

		expect(useStore.getState().pendingChanges.size).toBe(0);
	});

	it('removes entry when create followed by delete (net no-op)', () => {
		useStore.getState().addPendingChange({
			path: '/src/new-file.ts',
			action: 'create',
			beforeContent: undefined,
			afterContent: 'new content',
			snapshotId: 'snap-1',
			sessionId: 'test-session',
		});
		useStore.getState().addPendingChange({
			path: '/src/new-file.ts',
			action: 'delete',
			beforeContent: 'new content',
			afterContent: undefined,
			snapshotId: 'snap-1',
			sessionId: 'test-session',
		});

		expect(useStore.getState().pendingChanges.has('/src/new-file.ts')).toBe(false);
	});

	it('keeps action as create when create followed by edit', () => {
		useStore.getState().addPendingChange({
			path: '/src/new-file.ts',
			action: 'create',
			beforeContent: undefined,
			afterContent: 'initial content',
			snapshotId: 'snap-1',
			sessionId: 'test-session',
		});
		useStore.getState().addPendingChange({
			path: '/src/new-file.ts',
			action: 'edit',
			beforeContent: 'initial content',
			afterContent: 'updated content',
			snapshotId: 'snap-1',
			sessionId: 'test-session',
		});

		const change = useStore.getState().pendingChanges.get('/src/new-file.ts');
		expect(change?.action).toBe('create');
		expect(change?.beforeContent).toBeUndefined();
		expect(change?.afterContent).toBe('updated content');
	});

	it('treats delete followed by create as an edit', () => {
		useStore.getState().addPendingChange({
			path: '/src/main.ts',
			action: 'delete',
			beforeContent: 'original content',
			afterContent: undefined,
			snapshotId: 'snap-1',
			sessionId: 'test-session',
		});
		useStore.getState().addPendingChange({
			path: '/src/main.ts',
			action: 'create',
			beforeContent: undefined,
			afterContent: 'recreated content',
			snapshotId: 'snap-1',
			sessionId: 'test-session',
		});

		const change = useStore.getState().pendingChanges.get('/src/main.ts');
		expect(change?.action).toBe('edit');
		expect(change?.beforeContent).toBe('original content');
		expect(change?.afterContent).toBe('recreated content');
	});

	it('preserves snapshotId when re-adding a change for the same file', () => {
		useStore.getState().addPendingChange({ ...sampleChange, snapshotId: 'snap-123' });
		useStore.getState().addPendingChange({
			...sampleChange,
			afterContent: 'final content',
			snapshotId: undefined,
		});

		const change = useStore.getState().pendingChanges.get('/src/main.ts');
		expect(change?.snapshotId).toBe('snap-123');
		expect(change?.beforeContent).toBe('old content');
		expect(change?.afterContent).toBe('final content');
	});

	it('skips entry when beforeContent equals afterContent (no actual change)', () => {
		useStore.getState().addPendingChange({
			path: '/src/main.ts',
			action: 'edit',
			beforeContent: 'same content',
			afterContent: 'same content',
			snapshotId: undefined,
			sessionId: 'test-session',
		});

		expect(useStore.getState().pendingChanges.has('/src/main.ts')).toBe(false);
	});

	it('removes entry when edit reverts content back to original', () => {
		useStore.getState().addPendingChange({
			path: '/src/main.ts',
			action: 'edit',
			beforeContent: 'original',
			afterContent: 'changed',
			snapshotId: undefined,
			sessionId: 'test-session',
		});
		useStore.getState().addPendingChange({
			path: '/src/main.ts',
			action: 'edit',
			beforeContent: 'changed',
			afterContent: 'original',
			snapshotId: undefined,
			sessionId: 'test-session',
		});

		expect(useStore.getState().pendingChanges.has('/src/main.ts')).toBe(false);
	});

	it('removes entry when delete→create restores identical content', () => {
		useStore.getState().addPendingChange({
			path: '/src/main.ts',
			action: 'delete',
			beforeContent: 'original',
			afterContent: undefined,
			snapshotId: undefined,
			sessionId: 'test-session',
		});
		useStore.getState().addPendingChange({
			path: '/src/main.ts',
			action: 'create',
			beforeContent: undefined,
			afterContent: 'original',
			snapshotId: undefined,
			sessionId: 'test-session',
		});

		expect(useStore.getState().pendingChanges.has('/src/main.ts')).toBe(false);
	});

	it('adds move action as pending', () => {
		useStore.getState().addPendingChange({
			path: '/src/old.ts → /src/new.ts',
			action: 'move',
			beforeContent: undefined,
			afterContent: undefined,
			snapshotId: 'snap-1',
			sessionId: 'test-session',
		});

		const change = useStore.getState().pendingChanges.get('/src/old.ts → /src/new.ts');
		expect(change).toBeDefined();
		expect(change?.action).toBe('move');
		expect(change?.status).toBe('pending');
	});

	it('does not skip move action even when beforeContent equals afterContent', () => {
		useStore.getState().addPendingChange({
			path: '/src/old.ts → /src/new.ts',
			action: 'move',
			beforeContent: 'same',
			afterContent: 'same',
			snapshotId: undefined,
			sessionId: 'test-session',
		});

		expect(useStore.getState().pendingChanges.has('/src/old.ts → /src/new.ts')).toBe(true);
	});

	it('resets hunkStatuses to empty when deduplicating a change', () => {
		useStore.getState().addPendingChange(sampleChange);
		// Manually set hunkStatuses to simulate initialization
		useStore.setState((state) => {
			const newMap = new Map(state.pendingChanges);
			const change = newMap.get('/src/main.ts')!;
			newMap.set('/src/main.ts', { ...change, hunkStatuses: ['pending', 'approved'] });
			return { pendingChanges: newMap };
		});
		// Adding a new change for the same path should reset hunkStatuses
		useStore.getState().addPendingChange({
			...sampleChange,
			afterContent: 'final content',
		});

		const change = useStore.getState().pendingChanges.get('/src/main.ts');
		expect(change?.hunkStatuses).toEqual([]);
	});

	it('approves a single hunk', () => {
		useStore.getState().addPendingChange(sampleChange);
		// Simulate hunkStatuses initialization
		useStore.setState((state) => {
			const newMap = new Map(state.pendingChanges);
			const change = newMap.get('/src/main.ts')!;
			newMap.set('/src/main.ts', { ...change, hunkStatuses: ['pending', 'pending', 'pending'] });
			return { pendingChanges: newMap };
		});

		useStore.getState().approveHunk('/src/main.ts', 1);

		const change = useStore.getState().pendingChanges.get('/src/main.ts');
		expect(change?.hunkStatuses).toEqual(['pending', 'approved', 'pending']);
		expect(change?.status).toBe('pending');
	});

	it('rejects a single hunk', () => {
		useStore.getState().addPendingChange(sampleChange);
		useStore.setState((state) => {
			const newMap = new Map(state.pendingChanges);
			const change = newMap.get('/src/main.ts')!;
			newMap.set('/src/main.ts', { ...change, hunkStatuses: ['pending', 'pending'] });
			return { pendingChanges: newMap };
		});

		useStore.getState().rejectHunk('/src/main.ts', 0);

		const change = useStore.getState().pendingChanges.get('/src/main.ts');
		expect(change?.hunkStatuses).toEqual(['rejected', 'pending']);
		expect(change?.status).toBe('pending');
	});

	it('marks file as approved when all hunks are approved', () => {
		useStore.getState().addPendingChange(sampleChange);
		useStore.setState((state) => {
			const newMap = new Map(state.pendingChanges);
			const change = newMap.get('/src/main.ts')!;
			newMap.set('/src/main.ts', { ...change, hunkStatuses: ['pending', 'pending'] });
			return { pendingChanges: newMap };
		});

		useStore.getState().approveHunk('/src/main.ts', 0);
		useStore.getState().approveHunk('/src/main.ts', 1);

		const change = useStore.getState().pendingChanges.get('/src/main.ts');
		expect(change?.hunkStatuses).toEqual(['approved', 'approved']);
		expect(change?.status).toBe('approved');
	});

	it('marks file as rejected when all hunks are rejected', () => {
		useStore.getState().addPendingChange(sampleChange);
		useStore.setState((state) => {
			const newMap = new Map(state.pendingChanges);
			const change = newMap.get('/src/main.ts')!;
			newMap.set('/src/main.ts', { ...change, hunkStatuses: ['pending', 'pending'] });
			return { pendingChanges: newMap };
		});

		useStore.getState().rejectHunk('/src/main.ts', 0);
		useStore.getState().rejectHunk('/src/main.ts', 1);

		const change = useStore.getState().pendingChanges.get('/src/main.ts');
		expect(change?.hunkStatuses).toEqual(['rejected', 'rejected']);
		expect(change?.status).toBe('rejected');
	});

	it('resolves file when hunks have mixed decisions and all are resolved', () => {
		useStore.getState().addPendingChange(sampleChange);
		useStore.setState((state) => {
			const newMap = new Map(state.pendingChanges);
			const change = newMap.get('/src/main.ts')!;
			newMap.set('/src/main.ts', { ...change, hunkStatuses: ['pending', 'pending'] });
			return { pendingChanges: newMap };
		});

		useStore.getState().approveHunk('/src/main.ts', 0);
		useStore.getState().rejectHunk('/src/main.ts', 1);

		const change = useStore.getState().pendingChanges.get('/src/main.ts');
		expect(change?.hunkStatuses).toEqual(['approved', 'rejected']);
		// Mixed decisions: file is resolved (not stuck pending) — the last action
		// was rejectHunk, so the file-level status reflects the reject decision.
		expect(change?.status).toBe('rejected');
	});

	it('only changes pending hunkStatuses when approving a file-level change', () => {
		useStore.getState().addPendingChange(sampleChange);
		useStore.setState((state) => {
			const newMap = new Map(state.pendingChanges);
			const change = newMap.get('/src/main.ts')!;
			newMap.set('/src/main.ts', { ...change, hunkStatuses: ['pending', 'rejected', 'pending'] });
			return { pendingChanges: newMap };
		});

		useStore.getState().approveChange('/src/main.ts');

		const change = useStore.getState().pendingChanges.get('/src/main.ts');
		expect(change?.status).toBe('approved');
		expect(change?.hunkStatuses).toEqual(['approved', 'rejected', 'approved']);
	});

	it('only changes pending hunkStatuses when rejecting a file-level change', () => {
		useStore.getState().addPendingChange(sampleChange);
		useStore.setState((state) => {
			const newMap = new Map(state.pendingChanges);
			const change = newMap.get('/src/main.ts')!;
			newMap.set('/src/main.ts', { ...change, hunkStatuses: ['approved', 'pending'] });
			return { pendingChanges: newMap };
		});

		useStore.getState().rejectChange('/src/main.ts');

		const change = useStore.getState().pendingChanges.get('/src/main.ts');
		expect(change?.status).toBe('rejected');
		expect(change?.hunkStatuses).toEqual(['approved', 'rejected']);
	});

	it('only changes pending hunkStatuses when approving all changes', () => {
		useStore.getState().addPendingChange(sampleChange);
		useStore.setState((state) => {
			const newMap = new Map(state.pendingChanges);
			const change = newMap.get('/src/main.ts')!;
			newMap.set('/src/main.ts', { ...change, hunkStatuses: ['rejected', 'pending'] });
			return { pendingChanges: newMap };
		});

		useStore.getState().approveAllChanges();

		const change = useStore.getState().pendingChanges.get('/src/main.ts');
		expect(change?.status).toBe('approved');
		expect(change?.hunkStatuses).toEqual(['rejected', 'approved']);
	});

	it('only changes pending hunkStatuses when rejecting all changes', () => {
		useStore.getState().addPendingChange(sampleChange);
		useStore.setState((state) => {
			const newMap = new Map(state.pendingChanges);
			const change = newMap.get('/src/main.ts')!;
			newMap.set('/src/main.ts', { ...change, hunkStatuses: ['approved', 'pending'] });
			return { pendingChanges: newMap };
		});

		useStore.getState().rejectAllChanges();

		// File was 'pending' so it should be rejected; only pending hunkStatuses change
		const change = useStore.getState().pendingChanges.get('/src/main.ts');
		expect(change?.status).toBe('rejected');
		expect(change?.hunkStatuses).toEqual(['approved', 'rejected']);
	});
	it('clears pending changes by file paths', () => {
		useStore.getState().addPendingChange(sampleChange);
		useStore.getState().addPendingChange({ ...sampleChange, path: '/src/app.tsx' });
		useStore.getState().addPendingChange({ ...sampleChange, path: '/src/utils.ts' });

		useStore.getState().clearPendingChangesByPaths(new Set(['/src/main.ts', '/src/utils.ts']));

		const remaining = useStore.getState().pendingChanges;
		expect(remaining.size).toBe(1);
		expect(remaining.has('/src/app.tsx')).toBe(true);
	});

	it('is a no-op when clearing by empty path set', () => {
		useStore.getState().addPendingChange(sampleChange);

		useStore.getState().clearPendingChangesByPaths(new Set());

		expect(useStore.getState().pendingChanges.size).toBe(1);
	});

	it('approves all changes scoped to a session ID', () => {
		useStore.getState().addPendingChange({ ...sampleChange, sessionId: 'session-1' });
		useStore.getState().addPendingChange({ ...sampleChange, path: '/src/app.tsx', sessionId: 'session-2' });

		useStore.getState().approveAllChanges('session-1');

		expect(useStore.getState().pendingChanges.get('/src/main.ts')?.status).toBe('approved');
		expect(useStore.getState().pendingChanges.get('/src/app.tsx')?.status).toBe('pending');
	});

	it('rejects all changes scoped to a session ID', () => {
		useStore.getState().addPendingChange({ ...sampleChange, sessionId: 'session-1' });
		useStore.getState().addPendingChange({ ...sampleChange, path: '/src/app.tsx', sessionId: 'session-2' });

		useStore.getState().rejectAllChanges('session-1');

		expect(useStore.getState().pendingChanges.get('/src/main.ts')?.status).toBe('rejected');
		expect(useStore.getState().pendingChanges.get('/src/app.tsx')?.status).toBe('pending');
	});
});

describe('Agent mode', () => {
	it('defaults agentMode to code', () => {
		expect(useStore.getState().agentMode).toBe('code');
	});

	it('sets agentMode', () => {
		useStore.getState().setAgentMode('plan');
		expect(useStore.getState().agentMode).toBe('plan');
		useStore.getState().setAgentMode('ask');
		expect(useStore.getState().agentMode).toBe('ask');
		useStore.getState().setAgentMode('code');
		expect(useStore.getState().agentMode).toBe('code');
	});
});

describe('UI slice', () => {
	it('toggles sidebar', () => {
		expect(useStore.getState().sidebarVisible).toBe(true);
		useStore.getState().toggleSidebar();
		expect(useStore.getState().sidebarVisible).toBe(false);
		useStore.getState().toggleSidebar();
		expect(useStore.getState().sidebarVisible).toBe(true);
	});

	it('toggles utility panel', () => {
		expect(useStore.getState().utilityPanelVisible).toBe(true);
		useStore.getState().toggleUtilityPanel();
		expect(useStore.getState().utilityPanelVisible).toBe(false);
	});

	it('toggles agent panel', () => {
		expect(useStore.getState().agentPanelVisible).toBe(false);
		useStore.getState().toggleAgentPanel();
		expect(useStore.getState().agentPanelVisible).toBe(true);
	});

	it('shows the agent panel and switches mobile to agent', () => {
		useStore.getState().setActiveMobilePanel('preview');

		useStore.getState().showAgentPanel();

		expect(useStore.getState().agentPanelVisible).toBe(true);
		expect(useStore.getState().activeMobilePanel).toBe('agent');
	});

	it('requests an agent session and clears the request', () => {
		useStore.getState().setActiveMobilePanel('preview');

		useStore.getState().requestAgentSession('session-2');

		expect(useStore.getState().agentPanelVisible).toBe(true);
		expect(useStore.getState().activeMobilePanel).toBe('agent');
		expect(useStore.getState().requestedAgentSessionId).toBe('session-2');

		useStore.getState().clearRequestedAgentSession();

		expect(useStore.getState().requestedAgentSessionId).toBeUndefined();
	});

	it('queues and consumes preview element references', () => {
		useStore.getState().queuePreviewElementReference({ tagName: 'div', primarySelector: '#hero', locatorCandidates: [] });
		useStore.getState().queuePreviewElementReference({ tagName: 'img', primarySelector: '.card img', locatorCandidates: [] });

		expect(useStore.getState().pendingPreviewElementReferences).toEqual([
			{ tagName: 'div', primarySelector: '#hero', locatorCandidates: [] },
			{ tagName: 'img', primarySelector: '.card img', locatorCandidates: [] },
		]);

		useStore.getState().shiftPendingPreviewElementReference();

		expect(useStore.getState().pendingPreviewElementReferences).toEqual([
			{ tagName: 'img', primarySelector: '.card img', locatorCandidates: [] },
		]);
	});

	it('toggles dependencies panel', () => {
		expect(useStore.getState().dependenciesPanelVisible).toBe(true);
		useStore.getState().toggleDependenciesPanel();
		expect(useStore.getState().dependenciesPanelVisible).toBe(false);
		useStore.getState().toggleDependenciesPanel();
		expect(useStore.getState().dependenciesPanelVisible).toBe(true);
	});

	it('shows dependencies panel', () => {
		useStore.getState().toggleDependenciesPanel(); // hide it first
		expect(useStore.getState().dependenciesPanelVisible).toBe(false);
		useStore.getState().showDependenciesPanel();
		expect(useStore.getState().dependenciesPanelVisible).toBe(true);
	});

	it('switches mobile to the editor when showing a git diff', () => {
		useStore.getState().setActiveMobilePanel('git');

		useStore.getState().showGitDiff({
			path: '/src/main.ts',
			beforeContent: 'before',
			afterContent: 'after',
		});

		const state = useStore.getState();
		expect(state.activeMobilePanel).toBe('editor');
		expect(state.activeFile).toBe('/src/main.ts');
		expect(state.openFiles).toContain('/src/main.ts');
		expect(state.gitDiffView).toEqual({
			path: '/src/main.ts',
			beforeContent: 'before',
			afterContent: 'after',
		});
	});
});
