import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { projectSocketSendReference } from '@/hooks/index';
import { useStore } from '@/lib/store';

import { useEditorState } from './use-editor-state';

const { mockFileContent } = vi.hoisted(() => ({ mockFileContent: { current: 'old content' } }));

vi.mock('@/features/agent/hooks/use-change-review', () => ({
	useChangeReview: () => ({}),
}));

// Use the real diff utilities (pure functions from shared) so the content
// derivation is exercised end-to-end; only the network-backed file hook is
// mocked, with its content configurable via `mockFileContent`.
vi.mock('@/features/editor/index', async () => {
	const actual = await vi.importActual<typeof import('@shared/review-diff')>('@shared/review-diff');
	return {
		computeDiffData: actual.computeDiffData,
		computeRebasedDiffData: actual.computeRebasedDiffData,
		groupHunksIntoChanges: actual.groupHunksIntoChanges,
		resolveReviewContent: actual.resolveReviewContent,
		useFileContent: () => ({
			content: mockFileContent.current,
			isLoading: false,
			saveFile: vi.fn(),
			isSaving: false,
		}),
	};
});

describe('useEditorState', () => {
	beforeEach(() => {
		mockFileContent.current = 'old content';
		useStore.setState({
			activeFile: '/src/app.ts',
			openFiles: ['/src/app.ts'],
			unsavedChanges: new Map(),
			pendingChanges: new Map(),
			cursorPosition: undefined,
			gitDiffView: undefined,
		});
	});

	afterEach(() => {
		projectSocketSendReference.current = undefined;
	});

	it('broadcasts editor content changes over the project socket immediately', () => {
		const send = vi.fn();
		projectSocketSendReference.current = send;
		const { result, unmount } = renderHook(() => useEditorState({ projectId: 'project-1' }));

		act(() => {
			result.current.handleEditorChange('new content');
		});

		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith({ type: 'file-edit', path: '/src/app.ts', content: 'new content' });
		expect(useStore.getState().unsavedChanges.get('/src/app.ts')).toBe(true);

		unmount();
	});

	it('broadcasts every editor content change without timeout batching', () => {
		const send = vi.fn();
		projectSocketSendReference.current = send;
		const { result, unmount } = renderHook(() => useEditorState({ projectId: 'project-1' }));

		act(() => {
			result.current.handleEditorChange('first');
			result.current.handleEditorChange('second');
		});

		expect(send).toHaveBeenCalledTimes(2);
		expect(send).toHaveBeenCalledWith({ type: 'file-edit', path: '/src/app.ts', content: 'first' });
		expect(send).toHaveBeenCalledWith({ type: 'file-edit', path: '/src/app.ts', content: 'second' });

		unmount();
	});

	it('broadcasts cursor metadata with editor content changes', () => {
		const send = vi.fn();
		projectSocketSendReference.current = send;
		const { result, unmount } = renderHook(() => useEditorState({ projectId: 'project-1' }));

		act(() => {
			result.current.handleEditorChange('selected content', { line: 2, column: 5, anchorLine: 2, anchorColumn: 1 });
		});

		expect(send).toHaveBeenCalledWith({
			type: 'file-edit',
			path: '/src/app.ts',
			content: 'selected content',
			cursor: { line: 2, ch: 5 },
			selection: { anchor: { line: 2, ch: 1 }, head: { line: 2, ch: 5 } },
		});
		expect(useStore.getState().cursorPosition).toEqual({ line: 2, column: 5 });
		expect(useStore.getState().fileCursorPositions.get('/src/app.ts')).toEqual({ line: 2, column: 5 });

		unmount();
	});

	it('does not fold human edits into pending agent diff content', () => {
		const send = vi.fn();
		projectSocketSendReference.current = send;
		useStore.setState({
			pendingChanges: new Map([
				[
					'/src/app.ts',
					{
						path: '/src/app.ts',
						action: 'edit',
						beforeContent: 'old content',
						afterContent: 'agent content',
						snapshotId: undefined,
						status: 'pending',
						hunkStatuses: ['pending'],
						sessionId: 'session-1',
					},
				],
			]),
		});
		const { result, unmount } = renderHook(() => useEditorState({ projectId: 'project-1' }));

		act(() => {
			result.current.handleEditorChange('human content');
		});

		expect(useStore.getState().pendingChanges.get('/src/app.ts')?.afterContent).toBe('agent content');
		expect(useStore.getState().unsavedChanges.get('/src/app.ts')).toBe(true);
		expect(send).toHaveBeenCalledWith({ type: 'file-edit', path: '/src/app.ts', content: 'human content' });

		unmount();
	});

	it('shows the agent after-content while all hunks are pending (diff visible)', () => {
		// On-disk content is the agent's after-content once the query has refreshed.
		mockFileContent.current = 'agent content';
		useStore.setState({
			pendingChanges: new Map([
				[
					'/src/app.ts',
					{
						path: '/src/app.ts',
						action: 'edit',
						beforeContent: 'old content',
						afterContent: 'agent content',
						snapshotId: undefined,
						status: 'pending',
						hunkStatuses: ['pending'],
						sessionId: 'session-1',
					},
				],
			]),
		});

		const { result, unmount } = renderHook(() => useEditorState({ projectId: 'project-1' }));

		expect(result.current.editorContent).toBe('agent content');
		expect(result.current.hasActiveDiff).toBe(true);
		expect(result.current.effectiveDiffData).toBeDefined();

		unmount();
	});

	it('reverts to the before-content instantly when the hunk is rejected', () => {
		mockFileContent.current = 'agent content';
		useStore.setState({
			pendingChanges: new Map([
				[
					'/src/app.ts',
					{
						path: '/src/app.ts',
						action: 'edit',
						beforeContent: 'old content',
						afterContent: 'agent content',
						snapshotId: undefined,
						status: 'rejected',
						hunkStatuses: ['rejected'],
						sessionId: 'session-1',
					},
				],
			]),
		});

		const { result, unmount } = renderHook(() => useEditorState({ projectId: 'project-1' }));

		// Pure derivation: rejected hunk reverts the region without any cache write.
		expect(result.current.editorContent).toBe('old content');

		unmount();
	});

	it('local typing takes precedence over the derived review content', () => {
		mockFileContent.current = 'agent content';
		useStore.setState({
			pendingChanges: new Map([
				[
					'/src/app.ts',
					{
						path: '/src/app.ts',
						action: 'edit',
						beforeContent: 'old content',
						afterContent: 'agent content',
						snapshotId: undefined,
						status: 'pending',
						hunkStatuses: ['pending'],
						sessionId: 'session-1',
					},
				],
			]),
		});

		const { result, unmount } = renderHook(() => useEditorState({ projectId: 'project-1' }));

		act(() => {
			result.current.handleEditorChange('human edit');
		});

		expect(result.current.editorContent).toBe('human edit');

		unmount();
	});
});
