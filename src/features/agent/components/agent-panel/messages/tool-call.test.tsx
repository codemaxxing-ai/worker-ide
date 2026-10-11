import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { InlineToolCall } from './tool-call';

describe('Computer tool cards', () => {
	it('renders backend, exit status and bounded command output', () => {
		render(
			<InlineToolCall
				toolCall={{ type: 'tool-call', toolCallId: 'exec-1', toolName: 'exec', arguments: { command: 'bun test', backend: 'container' } }}
				toolResult={{
					type: 'tool-result',
					toolCallId: 'exec-1',
					toolName: 'exec',
					result: JSON.stringify({ backend: 'container', exitCode: 1, stdout: 'one test failed', stderr: 'native error' }),
				}}
				isExpanded
				onToggleExpand={() => {}}
			/>,
		);
		expect(screen.getByText('container · Exit 1')).toBeInTheDocument();
		expect(screen.getByText(/Backend: container/)).toHaveTextContent('one test failed');
		expect(screen.getByText(/Backend: container/)).toHaveTextContent('native error');
	});
	it('renders cancellation and synchronization failures', () => {
		const { rerender } = render(
			<InlineToolCall
				toolCall={{ type: 'tool-call', toolCallId: 'exec-2', toolName: 'exec', arguments: { command: 'sleep 60' } }}
				toolResult={{
					type: 'tool-result',
					toolCallId: 'exec-2',
					toolName: 'exec',
					result: JSON.stringify({ backend: 'shell', exitCode: 137, stdout: '', stderr: '' }),
				}}
				isExpanded
				onToggleExpand={() => {}}
			/>,
		);
		expect(screen.getByText('shell · Cancelled')).toBeInTheDocument();
		rerender(
			<InlineToolCall
				toolCall={{ type: 'tool-call', toolCallId: 'exec-2', toolName: 'exec', arguments: { command: 'bun test' } }}
				toolResult={{
					type: 'tool-result',
					toolCallId: 'exec-2',
					toolName: 'exec',
					result: JSON.stringify({ backend: 'container', error: 'Synchronization pending; queued writes are waiting' }),
				}}
				isExpanded
				onToggleExpand={() => {}}
			/>,
		);
		expect(screen.getByText('container · Failed')).toBeInTheDocument();
		expect(screen.getByText(/Synchronization pending/)).toBeInTheDocument();
	});
	it('keeps rich file output visible', () => {
		render(
			<InlineToolCall
				toolCall={{ type: 'tool-call', toolCallId: 'read-1', toolName: 'read', arguments: { path: '/workspace/photo.png' } }}
				toolResult={{
					type: 'tool-result',
					toolCallId: 'read-1',
					toolName: 'read',
					result: JSON.stringify({ kind: 'image', mediaType: 'image/png', data: 'aGVsbG8=', name: 'photo.png', sizeBytes: 5 }),
				}}
				isExpanded
				onToggleExpand={() => {}}
			/>,
		);
		expect(screen.getByRole('img', { name: 'photo.png' })).toHaveAttribute('src', 'data:image/png;base64,aGVsbG8=');
	});
});
