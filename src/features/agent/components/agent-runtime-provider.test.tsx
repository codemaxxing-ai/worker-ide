import { fireEvent, render, screen, act, cleanup } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getActiveSessionId } from '@/lib/project-storage';
import { useStore } from '@/lib/store';
import { DEFAULT_AI_MODEL } from '@shared/constants';

import { useAgentRuntime } from './agent-runtime-context';
import { AgentRuntimeProvider } from './agent-runtime-provider';

import type { AgentState } from '@shared/agent-state';

const mocks = vi.hoisted(() => ({ useAgent: vi.fn(), setState: vi.fn() }));
vi.mock('agents/react', () => ({ useAgent: mocks.useAgent }));
function Inspector() {
	const runtime = useAgentRuntime();
	return (
		<div>
			<span data-testid="selected">{runtime.activeSessionId ?? 'new'}</span>
			<button onClick={() => runtime.selectSession('a')}>Select A</button>
			<button onClick={() => runtime.selectSession('b')}>Select B</button>
			<input
				aria-label="Draft"
				value={runtime.segments.map((segment) => (segment.type === 'text' ? segment.value : '')).join('')}
				onChange={(event) => runtime.setSegments([{ type: 'text', value: event.target.value }])}
			/>
		</div>
	);
}
let state: AgentState;
beforeEach(() => {
	cleanup();
	sessionStorage.clear();
	localStorage.clear();
	vi.clearAllMocks();
	useStore.setState({ requestedAgentSessionId: undefined, pendingChanges: new Map() });
	state = {
		ready: true,
		sessions: ['a', 'b'].map((id) => ({
			id,
			title: id,
			createdAt: 1,
			updatedAt: 1,
			model: DEFAULT_AI_MODEL,
			mode: 'code',
			status: 'idle',
			isRunning: false,
			revision: 0,
		})),
		reviewEntries: {},
		reviewSummary: { unresolvedCount: 0, reviewVersion: 0, sessionCounts: {} },
	};
	mocks.useAgent.mockImplementation(() => ({
		state,
		identified: true,
		connectionError: undefined,
		setState: mocks.setState,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	}));
});
describe('tab-local agent state', () => {
	it('retains a saved selection while the project directory is loading', () => {
		sessionStorage.setItem('think-session:project', 'a');
		state = { ...state, ready: false, sessions: [] };
		render(
			<AgentRuntimeProvider projectId="project">
				<Inspector />
			</AgentRuntimeProvider>,
		);
		expect(screen.getByTestId('selected')).toHaveTextContent('a');
		expect(getActiveSessionId('project')).toBe('a');
	});
	it('switches sessions without sending a server selection and restores each draft', () => {
		render(
			<AgentRuntimeProvider projectId="project">
				<Inspector />
			</AgentRuntimeProvider>,
		);
		fireEvent.click(screen.getByText('Select A'));
		fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'Draft A' } });
		fireEvent.click(screen.getByText('Select B'));
		expect(screen.getByLabelText('Draft')).toHaveValue('');
		fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'Draft B' } });
		fireEvent.click(screen.getByText('Select A'));
		expect(screen.getByLabelText('Draft')).toHaveValue('Draft A');
		expect(getActiveSessionId('project')).toBe('a');
		expect(mocks.setState).not.toHaveBeenCalled();
		expect(localStorage.length).toBe(0);
	});
	it('restores selection and draft after remounting the same tab', () => {
		const view = render(
			<AgentRuntimeProvider projectId="project">
				<Inspector />
			</AgentRuntimeProvider>,
		);
		fireEvent.click(screen.getByText('Select A'));
		fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'Saved draft' } });
		view.unmount();
		render(
			<AgentRuntimeProvider projectId="project">
				<Inspector />
			</AgentRuntimeProvider>,
		);
		expect(screen.getByTestId('selected')).toHaveTextContent('a');
		expect(screen.getByLabelText('Draft')).toHaveValue('Saved draft');
	});
	it('opens session deep links locally without disturbing another session on the server', () => {
		render(
			<AgentRuntimeProvider projectId="project">
				<Inspector />
			</AgentRuntimeProvider>,
		);
		act(() => useStore.setState({ requestedAgentSessionId: 'b' }));
		expect(screen.getByTestId('selected')).toHaveTextContent('b');
		fireEvent.click(screen.getByText('Select A'));
		act(() => useStore.setState({ requestedAgentSessionId: 'b' }));
		expect(screen.getByTestId('selected')).toHaveTextContent('b');
		expect(mocks.setState).not.toHaveBeenCalled();
	});
	it('stops observing a session deleted by another client', () => {
		sessionStorage.setItem('think-session:project', 'a');
		const view = render(
			<AgentRuntimeProvider projectId="project">
				<Inspector />
			</AgentRuntimeProvider>,
		);
		state = { ...state, sessions: state.sessions.filter((session) => session.id !== 'a') };
		view.rerender(
			<AgentRuntimeProvider projectId="project">
				<Inspector />
			</AgentRuntimeProvider>,
		);
		expect(screen.getByTestId('selected')).toHaveTextContent('new');
		expect(getActiveSessionId('project')).toBeUndefined();
	});
});
