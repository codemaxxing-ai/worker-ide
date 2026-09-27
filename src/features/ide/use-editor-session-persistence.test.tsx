import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useStore } from '@/lib/store';

import { useEditorSessionPersistence } from './use-editor-session-persistence';

const loadEditorSession = vi.fn();
const saveEditorSession = vi.fn();
const resolveEditorSession = vi.fn();

vi.mock('@/lib/editor-session', () => ({
	loadEditorSession: (...arguments_: unknown[]) => loadEditorSession(...arguments_),
	saveEditorSession: (...arguments_: unknown[]) => saveEditorSession(...arguments_),
	resolveEditorSession: (...arguments_: unknown[]) => resolveEditorSession(...arguments_),
}));

describe('useEditorSessionPersistence', () => {
	beforeEach(() => {
		loadEditorSession.mockReset();
		saveEditorSession.mockReset();
		resolveEditorSession.mockReset();
		useStore.setState({
			files: [{ path: '/src/leftover.ts', name: 'leftover.ts', isDirectory: false }],
			filesProjectId: 'project-new',
			isLoading: false,
			openFiles: ['/src/leftover.ts'],
			activeFile: '/src/leftover.ts',
			unsavedChanges: new Map(),
			fileScrollPositions: new Map(),
			fileCursorPositions: new Map(),
		});
	});

	it('clears stale editor state when the project has no session to restore', () => {
		const { unmount } = renderHook(() => useEditorSessionPersistence({ projectId: 'project-new' }));

		expect(useStore.getState().openFiles).toEqual([]);
		expect(useStore.getState().activeFile).toBeUndefined();

		unmount();
	});

	it('restores the persisted session when one exists', () => {
		useStore.setState({ filesProjectId: 'project-existing' });
		resolveEditorSession.mockReturnValue({
			openFiles: ['/src/a.ts'],
			activeFile: '/src/a.ts',
			scrollPositions: new Map(),
			cursorPositions: new Map(),
		});

		const { unmount } = renderHook(() => useEditorSessionPersistence({ projectId: 'project-existing' }));

		expect(useStore.getState().openFiles).toEqual(['/src/a.ts']);
		expect(useStore.getState().activeFile).toBe('/src/a.ts');

		unmount();
	});

	it('keeps newly opened tabs when the current project file list refreshes', () => {
		const { unmount } = renderHook(() => useEditorSessionPersistence({ projectId: 'project-new' }));
		act(() => {
			useStore.getState().openFile('/src/hello.txt');
			useStore.setState({
				files: [
					{ path: '/src/leftover.ts', name: 'leftover.ts', isDirectory: false },
					{ path: '/src/hello.txt', name: 'hello.txt', isDirectory: false },
				],
			});
		});

		expect(useStore.getState().openFiles).toEqual(['/src/hello.txt']);
		expect(useStore.getState().activeFile).toBe('/src/hello.txt');
		expect(loadEditorSession).toHaveBeenCalledTimes(1);
		unmount();
	});

	it('restores a different project after visiting one without a saved session', () => {
		useStore.setState({ filesProjectId: 'project-empty' });
		const { rerender, unmount } = renderHook(({ projectId }) => useEditorSessionPersistence({ projectId }), {
			initialProps: { projectId: 'project-empty' },
		});
		resolveEditorSession.mockReturnValue({
			openFiles: ['/src/saved.ts'],
			activeFile: '/src/saved.ts',
			scrollPositions: new Map(),
			cursorPositions: new Map(),
		});

		rerender({ projectId: 'project-saved' });
		expect(loadEditorSession).not.toHaveBeenCalledWith('project-saved');

		act(() => {
			useStore.setState({
				filesProjectId: 'project-saved',
				files: [{ path: '/src/saved.ts', name: 'saved.ts', isDirectory: false }],
			});
		});

		expect(loadEditorSession).toHaveBeenCalledWith('project-saved');
		expect(useStore.getState().activeFile).toBe('/src/saved.ts');
		unmount();
	});

	it('flushes the previous project session using its own editor state', () => {
		useStore.setState({ filesProjectId: 'project-first' });
		resolveEditorSession
			.mockReturnValueOnce({
				openFiles: ['/src/first.ts'],
				activeFile: '/src/first.ts',
				scrollPositions: new Map(),
				cursorPositions: new Map(),
			})
			.mockReturnValueOnce({
				openFiles: ['/src/second.ts'],
				activeFile: '/src/second.ts',
				scrollPositions: new Map(),
				cursorPositions: new Map(),
			});
		const { rerender, unmount } = renderHook(({ projectId }) => useEditorSessionPersistence({ projectId }), {
			initialProps: { projectId: 'project-first' },
		});

		rerender({ projectId: 'project-second' });
		act(() => {
			useStore.setState({
				filesProjectId: 'project-second',
				files: [{ path: '/src/second.ts', name: 'second.ts', isDirectory: false }],
			});
		});

		expect(saveEditorSession).toHaveBeenCalledWith('project-first', expect.objectContaining({ openFiles: ['/src/first.ts'] }));
		expect(saveEditorSession).not.toHaveBeenCalledWith('project-first', expect.objectContaining({ openFiles: ['/src/second.ts'] }));
		unmount();
	});
});
