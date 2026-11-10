import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_AI_MODEL } from '@shared/constants';

import { ProjectAgent } from './project-agent';

import type { AgentState, SessionSummary } from '@shared/agent-state';

function invoke(name: string, host: object, ...parameters: unknown[]) {
	const method: unknown = Reflect.get(ProjectAgent.prototype, name);
	if (typeof method !== 'function') throw new Error(`Missing method ${name}`);
	return Reflect.apply(method, host, parameters);
}
function setup() {
	const state: AgentState = {
		ready: true,
		sessions: [
			{
				id: 'session',
				title: 'Session',
				createdAt: 1,
				updatedAt: 1,
				isRunning: true,
				model: DEFAULT_AI_MODEL,
				mode: 'code',
				status: 'running',
				revision: 10,
				titleGenerated: true,
			},
		],
		reviewEntries: {},
		reviewSummary: { unresolvedCount: 0, reviewVersion: 0, sessionCounts: {} },
	};
	const child = {
		closeAdmissions: vi.fn(async () => {}),
		configureSessionTurn: vi.fn(async () => {}),
		submitTurn: vi.fn(async () => ({ accepted: false, submissionId: 'same', status: 'completed' })),
		cancelActiveSubmissions: vi.fn(async () => {}),
		flushFinalizations: vi.fn(async () => {}),
		waitForCompletion: vi.fn(async () => {}),
	};
	const host = {
		state,
		deletions: new Map<string, Promise<void>>(),
		ctx: { storage: { kv: new Map<string, boolean>() } },
		subAgent: vi.fn(async () => child),
		getChat: (id: string) => invoke('getChat', host, id),
		setState: vi.fn((next: AgentState) => {
			host.state = next;
		}),
		updateSession: (id: string, patch: Partial<SessionSummary>) => invoke('updateSession', host, id, patch),
		deleteSessionData: (id: string) => invoke('deleteSessionData', host, id),
		deleteSubAgent: vi.fn(async () => {}),
		reviews: { removeSession: vi.fn() },
		refreshReviews: vi.fn(),
		withWorkspace: vi.fn(async () => {}),
	};
	Object.assign(host.ctx.storage.kv, { put: (key: string, value: boolean) => host.ctx.storage.kv.set(key, value) });
	Object.assign(host, { dynamicAgents: { get: host.subAgent, delete: host.deleteSubAgent } });
	return { host, child };
}
describe('project session ownership', () => {
	it('ignores stale and repeated status reports without replacing newer session state', () => {
		const { host } = setup();
		invoke('updateSessionSummary', host, 'session', { status: 'completed', revision: 9 });
		invoke('updateSessionSummary', host, 'session', { status: 'completed', revision: 10 });
		expect(host.setState).not.toHaveBeenCalled();
		invoke('updateSessionSummary', host, 'session', { status: 'completed', revision: 11 });
		expect(host.state.sessions[0]).toMatchObject({ status: 'completed', isRunning: false });
		expect(host.state).not.toHaveProperty('currentSession');
	});
	it('rejects client-owned directory state before accepting forged sessions', () => {
		expect(() => invoke('validateStateChange', {}, {}, { id: 'client' })).toThrow('server-owned');
		expect(() => invoke('validateStateChange', {}, {}, 'server')).not.toThrow();
	});
	it('deduplicates concurrent session creation after the child is configured', async () => {
		const { host, child } = setup();
		host.state.sessions = [];
		const pending = Promise.withResolvers<void>();
		child.configureSessionTurn.mockReturnValue(pending.promise);
		const input = {
			id: 'new-session',
			projectId: 'project',
			requestOriginContext: { appOrigin: 'https://app.example', contentOrigin: 'https://content.example' },
		};
		const first = invoke('createSession', host, input);
		const second = invoke('createSession', host, input);
		pending.resolve();
		await Promise.all([first, second]);
		expect(host.state.sessions).toHaveLength(1);
	});
	it('drains cancellation and finalization before deleting the owning facet', async () => {
		const { host, child } = setup();
		const cancellation = Promise.withResolvers<void>();
		child.cancelActiveSubmissions.mockReturnValue(cancellation.promise);
		const deleting = invoke('deleteSession', host, 'session');
		await Promise.resolve();
		expect(host.deleteSubAgent).not.toHaveBeenCalled();
		cancellation.resolve();
		await deleting;
		expect(child.closeAdmissions.mock.invocationCallOrder[0]).toBeLessThan(child.cancelActiveSubmissions.mock.invocationCallOrder[0]);
		expect(child.flushFinalizations.mock.invocationCallOrder[0]).toBeLessThan(host.deleteSubAgent.mock.invocationCallOrder[0]);
		expect(host.state.sessions).toEqual([]);
	});
	it('retains a session when its finalization has not been delivered', async () => {
		const { host, child } = setup();
		child.flushFinalizations.mockRejectedValue(new Error('Delivery failed'));
		await expect(invoke('deleteSession', host, 'session')).rejects.toThrow('Delivery failed');
		expect(host.deleteSubAgent).not.toHaveBeenCalled();
		expect(host.state.sessions).toHaveLength(1);
		await expect(invoke('submitMessage', host, 'session', {})).rejects.toThrow('being deleted');
		expect(
			await invoke('onBeforeSubAgent', host, new Request('https://example.com'), { className: 'SessionTurnAgent', name: 'session' }),
		).toHaveProperty('status', 404);
		child.flushFinalizations.mockResolvedValue();
		await invoke('deleteSession', host, 'session');
		expect(host.state.sessions).toEqual([]);
	});
	it('closes parent admissions during finalization and deduplicates concurrent deletion', async () => {
		const { host, child } = setup();
		const finalization = Promise.withResolvers<void>();
		child.flushFinalizations.mockReturnValue(finalization.promise);
		const deleting = invoke('deleteSession', host, 'session');
		await vi.waitFor(() => expect(child.flushFinalizations).toHaveBeenCalledOnce());
		await expect(invoke('submitMessage', host, 'session', {})).rejects.toThrow('being deleted');
		const repeated = invoke('deleteSession', host, 'session');
		finalization.resolve();
		await Promise.all([deleting, repeated]);
		expect(host.deleteSubAgent).toHaveBeenCalledOnce();
		await expect(invoke('createSession', host, { id: 'session' })).rejects.toThrow('being deleted');
	});
	it('retains the closed session for retry when generated-artifact cleanup fails', async () => {
		const { host } = setup();
		host.withWorkspace.mockRejectedValueOnce(new Error('Workspace unavailable'));
		await expect(invoke('deleteSession', host, 'session')).rejects.toThrow('Workspace unavailable');
		expect(host.deleteSubAgent).not.toHaveBeenCalled();
		expect(host.state.sessions).toHaveLength(1);
		await invoke('deleteSession', host, 'session');
		expect(host.withWorkspace).toHaveBeenCalledTimes(2);
		expect(host.deleteSubAgent).toHaveBeenCalledOnce();
	});
	it('forwards admission receipts without maintaining a second transcript', async () => {
		const { host, child } = setup();
		const message = { id: 'same', role: 'user', parts: [{ type: 'text', text: 'Hello' }] };
		expect(await invoke('submitMessage', host, 'session', message)).toMatchObject({ accepted: false });
		expect(child.submitTurn).toHaveBeenCalledWith(message);
		expect(host.setState).not.toHaveBeenCalled();
	});
});
