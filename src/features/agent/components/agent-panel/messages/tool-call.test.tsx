import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { toolInputSchemas } from '@shared/validation';

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

const toolNames = [...Object.keys(toolInputSchemas), 'mcp_custom_search', 'extension_custom_tool'];

describe('shared tool call lifecycle', () => {
	it.each(toolNames)('allows inspecting %s before arguments or results arrive', (toolName) => {
		const toggle = vi.fn();
		const { rerender } = render(
			<InlineToolCall
				toolCall={{ type: 'tool-call', toolCallId: 'pending', toolName, arguments: {} }}
				isStreaming
				isExpanded={false}
				onToggleExpand={toggle}
			/>,
		);
		const button = screen.getByRole('button');
		expect(button).toHaveAttribute('aria-expanded', 'false');
		fireEvent.click(button);
		expect(toggle).toHaveBeenCalledOnce();
		rerender(
			<InlineToolCall
				toolCall={{ type: 'tool-call', toolCallId: 'pending', toolName, arguments: { path: '/src/app.tsx', content: 'partial' } }}
				isStreaming
				isExpanded
				onToggleExpand={toggle}
			/>,
		);
		expect(screen.getByText('Arguments')).toBeInTheDocument();
		expect(screen.getByText(/"content": "partial"/)).toBeInTheDocument();
		expect(screen.queryByText(/Unsupported tool/)).not.toBeInTheDocument();
	});

	it.each(toolNames)('shows returned errors for %s as failures with inspectable details', (toolName) => {
		render(
			<InlineToolCall
				toolCall={{ type: 'tool-call', toolCallId: 'failed', toolName, arguments: {} }}
				toolResult={{ type: 'tool-result', toolCallId: 'failed', toolName, result: JSON.stringify({ error: 'Workspace unavailable' }) }}
				isExpanded
				onToggleExpand={() => {}}
			/>,
		);
		expect(screen.getByRole('button').className).toContain('text-error');
		expect(screen.getByText('Workspace unavailable')).toBeInTheDocument();
	});

	it('shows valid dynamically registered tool results without calling them unsupported', () => {
		render(
			<InlineToolCall
				toolCall={{ type: 'tool-call', toolCallId: 'dynamic', toolName: 'mcp_custom_search', arguments: { query: 'test' } }}
				toolResult={{ type: 'tool-result', toolCallId: 'dynamic', toolName: 'mcp_custom_search', result: 'Found one result' }}
				isExpanded
				onToggleExpand={() => {}}
			/>,
		);
		expect(screen.getByText('Completed')).toBeInTheDocument();
		expect(screen.getByText('Found one result')).toBeInTheDocument();
		expect(screen.getByRole('button').className).not.toContain('text-error');
	});

	it('shows structured errors even for tools absent from the static schema', () => {
		render(
			<InlineToolCall
				toolCall={{ type: 'tool-call', toolCallId: 'missing', toolName: 'unknown_tool', arguments: {} }}
				toolErrors={
					new Map([
						[
							'missing',
							{ toolCallId: 'missing', toolName: 'unknown_tool', errorCode: 'UNKNOWN_TOOL', errorMessage: 'No such tool exists' },
						],
					])
				}
				isExpanded
				onToggleExpand={() => {}}
			/>,
		);
		expect(screen.getByText('No such tool exists')).toBeInTheDocument();
		expect(screen.getByText('[UNKNOWN_TOOL] No such tool exists')).toBeInTheDocument();
		expect(screen.getByRole('button').className).toContain('text-error');
	});
});

describe('live command output', () => {
	it('renders partial streams while running and replaces them with final results', () => {
		const toolCall = {
			type: 'tool-call',
			toolCallId: 'live',
			toolName: 'exec',
			arguments: { command: 'bun test' },
		} satisfies import('@shared/types').ToolCallPart;
		const metadata = new Map([
			[
				'live',
				{
					toolCallId: 'live',
					toolName: 'exec',
					title: 'exec',
					metadata: {},
					commandOutput: {
						executions: [
							{
								executionId: 'one',
								stdout: 'partial progress',
								stderr: 'partial warning',
								stdoutBytes: 16,
								stderrBytes: 15,
								truncated: true,
							},
						],
						truncated: true,
					},
				},
			],
		]);
		const { rerender } = render(
			<InlineToolCall toolCall={toolCall} toolMetadata={metadata} isStreaming isExpanded onToggleExpand={() => {}} />,
		);
		expect(screen.getByText('partial progress')).toBeInTheDocument();
		expect(screen.getByText('partial warning')).toBeInTheDocument();
		expect(screen.getByText('Output truncated')).toBeInTheDocument();
		rerender(
			<InlineToolCall
				toolCall={toolCall}
				toolMetadata={metadata}
				toolResult={{
					type: 'tool-result',
					toolCallId: 'live',
					toolName: 'exec',
					result: JSON.stringify({ exitCode: 0, stdout: 'final output', stderr: '' }),
				}}
				isExpanded
				onToggleExpand={() => {}}
			/>,
		);
		expect(screen.queryByText('partial progress')).not.toBeInTheDocument();
		expect(screen.getByText(/final output/)).toBeInTheDocument();
	});
});
