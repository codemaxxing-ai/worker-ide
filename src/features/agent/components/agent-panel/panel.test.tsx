import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { initialChatState } from '@shared/agent-chat';
import { DEFAULT_AI_MODEL } from '@shared/constants';

import { AgentTranscript } from './agent-transcript';
import { AgentSessionList } from './session-list';

import type { AgentMessage } from '@shared/agent-chat';
import type { SessionSummary } from '@shared/agent-state';

const session: SessionSummary = {
	id: 'session',
	title: 'Implement preview',
	createdAt: 1,
	updatedAt: 1,
	model: DEFAULT_AI_MODEL,
	mode: 'code',
	status: 'idle',
	isRunning: false,
	revision: 0,
};

describe('native agent panel components', () => {
	it('renders persisted native messages, authors, and attachments', () => {
		const messages: AgentMessage[] = [
			{
				id: 'user',
				role: 'user',
				metadata: { createdAt: 1, authorName: 'Alice' },
				parts: [
					{ type: 'text', text: 'Please inspect this image.' },
					{ type: 'file', url: 'data:image/png;base64,aGVsbG8=', mediaType: 'image/png', filename: 'preview.png' },
				],
			},
		];
		render(
			<MemoryRouter>
				<AgentTranscript messages={messages} projectId="project" />
			</MemoryRouter>,
		);
		expect(screen.getByText('Alice')).toBeInTheDocument();
		expect(screen.getByText('Please inspect this image.')).toBeInTheDocument();
		expect(screen.getByAltText('preview.png')).toHaveAttribute('src', 'data:image/png;base64,aGVsbG8=');
	});
	it('keeps streamed tool arguments expandable and restores details from the persisted output', () => {
		const message: AgentMessage = {
			id: 'assistant',
			role: 'assistant',
			parts: [
				{ type: 'dynamic-tool', toolName: 'custom_tool', toolCallId: 'call', state: 'input-streaming', input: { path: '/source.ts' } },
			],
		};
		const view = render(
			<MemoryRouter>
				<AgentTranscript messages={[message]} state={{ ...initialChatState(), status: 'running' }} projectId="project" />
			</MemoryRouter>,
		);
		fireEvent.click(screen.getByRole('button', { expanded: false }));
		expect(view.container.textContent).toContain('/source.ts');
		const completed: AgentMessage = {
			...message,
			parts: [
				{
					type: 'dynamic-tool',
					toolName: 'custom_tool',
					toolCallId: 'call',
					state: 'output-available',
					input: { path: '/source.ts' },
					output: { title: 'Source result', metadata: {}, output: 'Verified source contents' },
				},
			],
		};
		view.rerender(
			<MemoryRouter>
				<AgentTranscript messages={[completed]} state={initialChatState()} projectId="project" />
			</MemoryRouter>,
		);
		expect(view.container.textContent).toContain('Verified source contents');
	});
	it('keeps selection separate from rename and confirmed deletion', async () => {
		const onSelect = vi.fn();
		const onRename = vi.fn(async () => {});
		const onDelete = vi.fn(async () => {});
		render(
			<AgentSessionList
				sessions={[session]}
				selectedId={session.id}
				query=""
				onQuery={vi.fn()}
				onSelect={onSelect}
				onNew={vi.fn()}
				onRename={onRename}
				onDelete={onDelete}
			/>,
		);
		fireEvent.click(screen.getByLabelText('Rename Implement preview'));
		fireEvent.change(screen.getByLabelText('Session title'), { target: { value: 'New name' } });
		fireEvent.click(screen.getByLabelText('Save session title'));
		await waitFor(() => expect(onRename).toHaveBeenCalledWith('session', 'New name'));
		fireEvent.click(screen.getByLabelText('Delete Implement preview'));
		expect(onDelete).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		await waitFor(() => expect(onDelete).toHaveBeenCalledWith('session'));
		expect(onSelect).not.toHaveBeenCalled();
	});
});
