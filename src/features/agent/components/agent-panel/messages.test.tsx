import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_AI_MODEL } from '@shared/constants';

import { AssistantMessage, MessageBubble, QueuedSteeringStrip } from './messages';

import type { ChatMessage } from '@shared/types';
import type { ReactElement } from 'react';

function renderWithProviders(ui: ReactElement) {
	return render(ui);
}

function createQueuedMessage(id: string, content: string): ChatMessage {
	return {
		id,
		role: 'user',
		authorUserId: `user-${id}`,
		parts: [{ type: 'text', content }],
		createdAt: 1,
		metadata: {
			request: {
				state: 'queued',
				mode: 'code',
				model: DEFAULT_AI_MODEL,
			},
		},
	};
}

describe('QueuedSteeringStrip', () => {
	it('renders a compact queued count when collapsed', () => {
		renderWithProviders(
			<QueuedSteeringStrip
				messages={[
					createQueuedMessage('1', 'First queued message'),
					createQueuedMessage('2', 'Second queued message'),
					createQueuedMessage('3', 'Third queued message'),
					createQueuedMessage('4', 'Fourth queued message'),
				]}
				currentUserId="user-1"
				sessionParticipants={{
					'user-1': { name: 'Taylor', color: '#f97316' },
					'user-2': { name: 'Alex', color: '#22d3ee' },
					'user-3': { name: 'Sam', color: '#a78bfa' },
					'user-4': { name: 'Jordan', color: '#f472b6' },
				}}
				onRemoveMessage={() => {}}
			/>,
		);

		expect(screen.getByRole('button', { name: 'Show 4 queued messages' })).toBeInTheDocument();
		expect(screen.getByText('First queued message')).toBeInTheDocument();
		expect(screen.getAllByLabelText('Remove queued message')).toHaveLength(1);
	});

	it('expands on click and reveals remove actions', async () => {
		renderWithProviders(
			<QueuedSteeringStrip
				messages={[
					createQueuedMessage('1', 'First queued message'),
					createQueuedMessage('2', 'Second queued message'),
					createQueuedMessage('3', 'Third queued message'),
					createQueuedMessage('4', 'Fourth queued message'),
				]}
				currentUserId="user-1"
				sessionParticipants={{
					'user-1': { name: 'Taylor', color: '#f97316' },
					'user-2': { name: 'Alex', color: '#22d3ee' },
					'user-3': { name: 'Sam', color: '#a78bfa' },
					'user-4': { name: 'Jordan', color: '#f472b6' },
				}}
				onRemoveMessage={() => {}}
			/>,
		);

		const trigger = screen.getByRole('button', { name: 'Show 4 queued messages' });
		fireEvent.click(trigger);

		await waitFor(() => {
			expect(screen.getAllByLabelText('Remove queued message')).toHaveLength(4);
		});
		expect(screen.getByText('Fourth queued message')).toBeInTheDocument();
		expect(screen.getByTitle('Alex')).toBeInTheDocument();
	});

	it('calls onRemoveMessage for the chosen card', async () => {
		const onRemoveMessage = vi.fn();
		renderWithProviders(
			<QueuedSteeringStrip
				messages={[createQueuedMessage('1', 'First queued message'), createQueuedMessage('2', 'Second queued message')]}
				currentUserId="user-1"
				sessionParticipants={{
					'user-1': { name: 'Taylor', color: '#f97316' },
					'user-2': { name: 'Alex', color: '#22d3ee' },
				}}
				onRemoveMessage={onRemoveMessage}
			/>,
		);

		const trigger = screen.getByRole('button', { name: 'Show 2 queued messages' });
		fireEvent.click(trigger);

		await waitFor(() => {
			expect(screen.getAllByLabelText('Remove queued message')).toHaveLength(2);
		});

		fireEvent.click(screen.getAllByLabelText('Remove queued message')[0]!);
		expect(onRemoveMessage).toHaveBeenCalledWith('1');
	});

	it('shows a dashed border for client-only queued messages', () => {
		renderWithProviders(
			<QueuedSteeringStrip
				messages={[createQueuedMessage('1', 'First queued message')]}
				currentUserId="user-1"
				sessionParticipants={{
					'user-1': { name: 'Taylor', color: '#f97316' },
				}}
				localOnlyMessageIds={new Set(['1'])}
				onRemoveMessage={() => {}}
			/>,
		);

		expect(screen.getByText('First queued message').closest('.border-dashed')).toBeInTheDocument();
	});
});

describe('MessageBubble', () => {
	it('shows a revert button for completed user turns even without a snapshot', () => {
		const onRevert = vi.fn();
		renderWithProviders(
			<MessageBubble
				message={{
					id: 'user-1',
					role: 'user',
					authorUserId: 'user-1',
					parts: [{ type: 'text', content: 'Fix the bug' }],
					createdAt: 1,
					metadata: {
						request: {
							state: 'committed',
							mode: 'code',
							model: DEFAULT_AI_MODEL,
						},
					},
				}}
				messageIndex={0}
				currentUserId="user-1"
				sessionParticipants={{ 'user-1': { name: 'Taylor', color: '#f97316' } }}
				canRevert
				isReverting={false}
				onRevert={onRevert}
			/>,
		);

		fireEvent.click(screen.getByRole('button', { name: /revert/i }));
		expect(onRevert).toHaveBeenCalledWith(0);
	});

	it('renders tool-call file references as standalone buttons', () => {
		renderWithProviders(
			<AssistantMessage
				message={{
					id: 'assistant-1',
					role: 'assistant',
					parts: [
						{
							type: 'tool-call',
							toolCallId: 'tool-1',
							toolName: 'lint_check',
							arguments: { path: '/src/main.ts' },
						},
						{
							type: 'tool-result',
							toolCallId: 'tool-1',
							toolName: 'lint_check',
							result: 'line 1',
						},
					],
					createdAt: 1,
				}}
			/>,
		);

		const toolCallToggle = screen.getByRole('button', { name: /lint check/i });
		expect(screen.getByText('main.ts').closest('[role="button"]')).toBeInTheDocument();
		expect(toolCallToggle.tagName).toBe('DIV');
	});

	it('shows the plan file reference for plan updates', () => {
		renderWithProviders(
			<AssistantMessage
				message={{
					id: 'assistant-plan',
					role: 'assistant',
					parts: [
						{
							type: 'tool-call',
							toolCallId: 'tool-plan',
							toolName: 'plan_update',
							arguments: { content: '# Plan' },
						},
						{
							type: 'tool-result',
							toolCallId: 'tool-plan',
							toolName: 'plan_update',
							result: 'Plan updated',
						},
					],
					createdAt: 1,
				}}
				toolMetadata={
					new Map([
						[
							'tool-plan',
							{
								toolCallId: 'tool-plan',
								toolName: 'plan_update',
								title: 'plan',
								metadata: { completedTasks: 1, totalTasks: 2, planFilePath: '.agent/plans/ses-123.md' },
							},
						],
					])
				}
			/>,
		);

		expect(screen.getByText('ses-123.md')).toBeInTheDocument();
		expect(screen.getByText('1/2')).toBeInTheDocument();
	});

	it('shows all completed TODOs after todos_update', () => {
		renderWithProviders(
			<AssistantMessage
				message={{
					id: 'assistant-todos',
					role: 'assistant',
					parts: [
						{
							type: 'tool-call',
							toolCallId: 'tool-todos',
							toolName: 'todos_update',
							arguments: {},
						},
						{
							type: 'tool-result',
							toolCallId: 'tool-todos',
							toolName: 'todos_update',
							result: 'Updated 2 TODO(s).',
						},
					],
					createdAt: 1,
				}}
				toolMetadata={
					new Map([
						[
							'tool-todos',
							{
								toolCallId: 'tool-todos',
								toolName: 'todos_update',
								title: 'todos',
								metadata: {
									todos: [
										{ id: 'one', content: 'Finish implementation', status: 'completed', priority: 'high' },
										{ id: 'two', content: 'Run validation', status: 'completed', priority: 'medium' },
									],
								},
							},
						],
					])
				}
			/>,
		);

		expect(screen.getByText('2/2 completed')).toBeInTheDocument();
		expect(screen.getByText('Finish implementation')).toBeInTheDocument();
		expect(screen.getByText('Run validation')).toBeInTheDocument();
	});

	it('renders TODOs from the persisted tool output without streamed metadata', () => {
		renderWithProviders(
			<AssistantMessage
				message={{
					id: 'assistant-persisted-todos',
					role: 'assistant',
					parts: [
						{ type: 'tool-call', toolCallId: 'persisted-todos', toolName: 'todos_get', arguments: {} },
						{
							type: 'tool-result',
							toolCallId: 'persisted-todos',
							toolName: 'todos_get',
							result: JSON.stringify({
								todos: [{ id: 'one', content: 'Verify persisted task', status: 'in_progress', priority: 'high' }],
							}),
						},
					],
					createdAt: 1,
				}}
			/>,
		);

		expect(screen.getByText('Verify persisted task')).toBeInTheDocument();
		expect(screen.getByText('high')).toBeInTheDocument();
	});

	it('shows current asset settings after asset_settings_update', () => {
		renderWithProviders(
			<AssistantMessage
				message={{
					id: 'assistant-asset-settings',
					role: 'assistant',
					parts: [
						{
							type: 'tool-call',
							toolCallId: 'tool-asset-settings',
							toolName: 'asset_settings_update',
							arguments: { not_found_handling: 'single-page-application' },
						},
						{
							type: 'tool-result',
							toolCallId: 'tool-asset-settings',
							toolName: 'asset_settings_update',
							result: 'Updated asset settings',
						},
					],
					createdAt: 1,
				}}
				toolMetadata={
					new Map([
						[
							'tool-asset-settings',
							{
								toolCallId: 'tool-asset-settings',
								toolName: 'asset_settings_update',
								title: 'asset settings updated',
								metadata: {
									assetSettings: {
										not_found_handling: 'single-page-application',
										html_handling: 'auto-trailing-slash',
										run_worker_first: ['/api/*', '!/api/docs/*'],
									},
									changes: ['not_found_handling = single-page-application'],
								},
							},
						],
					])
				}
			/>,
		);

		expect(screen.getByText('1 changed')).toBeInTheDocument();
		expect(screen.getByText('Asset settings')).toBeInTheDocument();
		expect(screen.getByText('not_found_handling')).toBeInTheDocument();
		expect(screen.getByText('single-page-application')).toBeInTheDocument();
		expect(screen.getByText('/api/*, !/api/docs/*')).toBeInTheDocument();
	});

	it('shows current bindings after bindings_update', () => {
		renderWithProviders(
			<AssistantMessage
				message={{
					id: 'assistant-bindings',
					role: 'assistant',
					parts: [
						{
							type: 'tool-call',
							toolCallId: 'tool-bindings',
							toolName: 'bindings_update',
							arguments: { storage: 'true' },
						},
						{
							type: 'tool-result',
							toolCallId: 'tool-bindings',
							toolName: 'bindings_update',
							result: 'Updated bindings',
						},
					],
					createdAt: 1,
				}}
				toolMetadata={
					new Map([
						[
							'tool-bindings',
							{
								toolCallId: 'tool-bindings',
								toolName: 'bindings_update',
								title: 'bindings updated',
								metadata: {
									bindingsConfig: { storage: true },
									changes: ['storage = enabled'],
								},
							},
						],
					])
				}
			/>,
		);

		expect(screen.getByText('1 changed')).toBeInTheDocument();
		expect(screen.getByText('Bindings')).toBeInTheDocument();
		expect(screen.getByText('storage')).toBeInTheDocument();
		expect(screen.getByText('enabled')).toBeInTheDocument();
	});

	it('shows the executed code and output when a codemode call is expanded', () => {
		renderWithProviders(
			<AssistantMessage
				message={{
					id: 'assistant-codemode',
					role: 'assistant',
					parts: [
						{
							type: 'tool-call',
							toolCallId: 'tool-codemode',
							toolName: 'codemode',
							arguments: { code: 'const files = await state.glob({ pattern: "src/**" });\nreturn files.length;' },
						},
						{
							type: 'tool-result',
							toolCallId: 'tool-codemode',
							toolName: 'codemode',
							result: JSON.stringify({ result: 42, logs: ['scanning src'] }),
						},
					],
					createdAt: 1,
				}}
			/>,
		);

		// Header shows the friendly summary, not raw JSON.
		expect(screen.getByText('Ran code')).toBeInTheDocument();

		// Expanding reveals the executed code plus parsed console/result sections.
		fireEvent.click(screen.getByRole('button', { name: /codemode/i }));
		expect(screen.getByText(/state\.glob/)).toBeInTheDocument();
		expect(screen.getByText(/scanning src/)).toBeInTheDocument();
		expect(screen.getByText(/Result:/)).toBeInTheDocument();
		expect(screen.getByText('Code')).toBeInTheDocument();
		expect(screen.getByText('Output')).toBeInTheDocument();
	});

	it('keeps a user-opened tool pill expanded when its state updates', () => {
		const completedMessage: ChatMessage = {
			id: 'assistant-lint',
			role: 'assistant',
			parts: [
				{
					type: 'tool-call',
					toolCallId: 'tool-lint',
					toolName: 'lint_check',
					arguments: { path: '/src/main.ts' },
				},
				{
					type: 'tool-result',
					toolCallId: 'tool-lint',
					toolName: 'lint_check',
					result: 'lint output here',
				},
			],
			createdAt: 1,
		};

		const { rerender } = render(<AssistantMessage message={completedMessage} />);

		// User opens the pill (it is expandable once completed with detail content).
		fireEvent.click(screen.getByRole('button', { name: /lint check/i }));
		expect(screen.getByText('lint output here')).toBeInTheDocument();

		// A state update arrives that would otherwise flip `expandable` to false
		// (the tool re-enters an in-flight, result-less state during streaming).
		// The pill must remain expandable rather than collapsing.
		rerender(
			<AssistantMessage
				message={{
					...completedMessage,
					parts: [completedMessage.parts[0]!],
				}}
				streaming
			/>,
		);

		expect(screen.getByRole('button', { name: /lint check/i })).toBeInTheDocument();
	});

	it('renders an unfinished dynamic tool with neutral styling', () => {
		renderWithProviders(
			<AssistantMessage
				message={{
					id: 'assistant-unknown',
					role: 'assistant',
					parts: [
						{
							type: 'tool-call',
							toolCallId: 'tool-unknown',
							toolName: 'file_grep',
							arguments: { pattern: 'src' },
						},
					],
					createdAt: 1,
				}}
			/>,
		);

		const summary = screen.getByText('Cancelled');
		expect(summary).toBeInTheDocument();

		// The row must not use the red error styling reserved for real failures.
		const row = summary.closest('div');
		expect(row?.className).not.toContain('text-error');
		expect(row?.className).not.toContain('bg-error');
	});

	it('shows collaborator names for non-self user messages', () => {
		renderWithProviders(
			<MessageBubble
				message={{
					id: 'user-2-message',
					role: 'user',
					authorUserId: 'user-2',
					parts: [{ type: 'text', content: 'Please check the queue' }],
					createdAt: 2,
					metadata: {
						request: {
							state: 'committed',
							mode: 'code',
							model: DEFAULT_AI_MODEL,
						},
					},
				}}
				messageIndex={1}
				currentUserId="user-1"
				sessionParticipants={{ 'user-2': { name: 'Alex', color: '#22d3ee' } }}
				canRevert={false}
				isReverting={false}
				onRevert={() => {}}
			/>,
		);

		expect(screen.getByText('Alex')).toBeInTheDocument();
	});
});
