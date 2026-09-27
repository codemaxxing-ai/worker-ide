import { describe, expect, it, vi } from 'vitest';

import { execute } from './sub-agent';
import { createMockContext, createMockSendEvent } from './test-helpers';
import { SubAgentWorker } from '../../../durable/sub-agent-worker';

// These tests verify the delegation contract; loading the real Think agent
// during a tool test makes the dynamic import depend on CI runner speed.
vi.mock('../../../durable/sub-agent-worker', () => ({
	SubAgentWorker: class SubAgentWorker {},
}));

describe('sub_agent', () => {
	it('delegates through the retained agent-tool API', async () => {
		const sendEvent = createMockSendEvent();
		const runAgentTool = vi.fn(async () => ({
			runId: 'agent-tool:call-abc',
			agentType: 'SubAgentWorker',
			status: 'completed' as const,
			summary: 'Sub-agent result',
		}));
		const indexArtifact = vi.fn(async () => {});
		const context = createMockContext({
			indexArtifact,
			sessionId: 'sess-1',
			toolCallId: 'call-abc',
			userId: 'user-123',
			organizationId: 'org-123',
			requestOriginContext: { baseDomain: 'example.com', protocol: 'https:' },
		});
		Object.defineProperty(context, 'agentReference', {
			value: { runAgentTool },
			configurable: true,
			writable: true,
		});

		const result = await execute({ prompt: 'Inspect the failing integration', context: 'Focus on src/example.ts' }, sendEvent, context, []);

		expect(runAgentTool).toHaveBeenCalledWith(
			SubAgentWorker,
			expect.objectContaining({
				runId: 'agent-tool:call-abc',
				parentToolCallId: 'call-abc',
				input: expect.objectContaining({
					prompt: 'Inspect the failing integration\n\nAdditional context:\nFocus on src/example.ts',
					projectId: 'test-project',
					organizationId: 'org-123',
					userId: 'user-123',
					requestOriginContext: { baseDomain: 'example.com', protocol: 'https:' },
					parentToolCallId: 'call-abc',
				}),
			}),
		);
		expect(result.output).toBe('Sub-agent result');
		expect(result.metadata).toMatchObject({ runId: 'agent-tool:call-abc', artifactKey: expect.any(String) });
		expect(indexArtifact).toHaveBeenCalledOnce();
		expect(sendEvent.calls.some(([type, payload]) => type === 'status' && payload.message === 'Delegating task to sub-agent...')).toBe(
			true,
		);
	}, 15_000);

	it('surfaces a failed retained run as a tool error', async () => {
		const context = createMockContext({ toolCallId: 'call-failed' });
		Object.defineProperty(context, 'agentReference', {
			value: {
				runAgentTool: vi.fn(async () => ({
					runId: 'agent-tool:call-failed',
					agentType: 'SubAgentWorker',
					status: 'error',
					error: 'Delegation failed',
				})),
			},
			configurable: true,
			writable: true,
		});

		await expect(execute({ prompt: 'Do the thing' }, createMockSendEvent(), context, [])).rejects.toThrow('Delegation failed');
	});
});
