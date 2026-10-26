import { WorkerEntrypoint, env as fixtureEnvironment } from 'cloudflare:workers';
import { z } from 'zod';

import { toHex } from '../../shared/project-id';
import { AgentRunner as ApplicationAgentRunner, SessionTurnAgent } from '../../worker/durable';

import type { AgentSessionState, StreamEvent } from '../../shared/agent-state';
import type { ChatMessage } from '../../shared/types';

export * from '../../worker/durable';

// Keep the application lifecycle intact; only the external documentation service
// and AI transport are replaced. The provider adapter still parses real SSE.
ApplicationAgentRunner.prototype.addMcpServer = async (): Promise<{ id: string; state: 'ready' }> => ({
	id: 'fixture-docs',
	state: 'ready',
});
SessionTurnAgent.prototype.addMcpServer = async (): Promise<{ id: string; state: 'ready' }> => ({ id: 'fixture-docs', state: 'ready' });
const aiBinding = fixtureEnvironment.AI;
Reflect.set(fixtureEnvironment, 'AI', {
	run: (model: string, input: unknown) => Reflect.apply(aiBinding.run, aiBinding, [model, input]),
});

export class AgentRunner extends ApplicationAgentRunner {
	private streamBatches = 0;
	private protocolBroadcasts = 0;
	private rejectCompletions = false;

	override async completeThinkTurn(...parameters: Parameters<ApplicationAgentRunner['completeThinkTurn']>): Promise<void> {
		if (this.rejectCompletions) throw new Error('Simulated exhausted completion RPC');
		await super.completeThinkTurn(...parameters);
	}

	blockCompletionForTest(): void {
		this.rejectCompletions = true;
	}

	async restoreCompletionForTest(): Promise<void> {
		this.rejectCompletions = false;
		await this.reconcileRunningSession();
	}

	async hasRecoveryWatchForTest(): Promise<boolean> {
		const schedules = await this.listSchedules();
		return schedules.some((schedule) => schedule.callback === 'reconcileRunningSession');
	}

	override async receiveThinkEvents(sessionId: string, events: StreamEvent[]): Promise<void> {
		this.streamBatches++;
		if (this.streamBatches > 500) throw new Error('Test RPC budget exhausted');
		await super.receiveThinkEvents(sessionId, events);
	}

	override async _cf_broadcastToSubAgent(...parameters: Parameters<ApplicationAgentRunner['_cf_broadcastToSubAgent']>): Promise<void> {
		this.protocolBroadcasts++;
		await super._cf_broadcastToSubAgent(...parameters);
	}

	readTestTraffic() {
		return { streamBatches: this.streamBatches, protocolBroadcasts: this.protocolBroadcasts };
	}

	readTestState(): AgentSessionState | undefined {
		return this.state.currentSession;
	}

	readTestSessionId(): string | undefined {
		return this.state.currentSession?.sessionId;
	}

	async inspectTestSubmission(sessionId: string, submissionId: string) {
		const child = await this.subAgent(SessionTurnAgent, sessionId);
		return child.inspectSubmission(submissionId);
	}

	evictForTest(): void {
		this.ctx.abort('Simulated session eviction');
	}

	async seedTestHistory(sessionId: string, history: ChatMessage[]): Promise<void> {
		this.sql`INSERT INTO assistant_sessions (id, name) VALUES (${sessionId}, 'Existing session')`;
		await this.completeThinkTurn(sessionId, 'previous', history, 'completed');
		await this.loadSession(sessionId);
	}
}

const inputSchema = z.object({
	stream: z.boolean().optional(),
	messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
});
const startedModelRequests = new Set<string>();

export class FixtureAI extends WorkerEntrypoint {
	async run(_model: string, rawInput: unknown) {
		const input = inputSchema.parse(rawInput);
		if (!input.stream) return Response.json({ response: 'Lifecycle test' });
		const prompt = String(input.messages.findLast((message) => message.role === 'user')?.content);
		startedModelRequests.add(prompt);
		if (prompt === 'stall-start') await new Promise((resolve) => setTimeout(resolve, 60_000));
		const finishedTool = input.messages.at(-1)?.role === 'tool';
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const send = (value: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
				if (prompt === 'stall') {
					send({
						choices: [
							{ delta: { tool_calls: [{ index: 0, id: 'stalled-write', type: 'function', function: { name: 'write', arguments: '' } }] } },
						],
					});
					heartbeat = setInterval(() => controller.enqueue(new TextEncoder().encode(': heartbeat\n\n')), 100);
					return;
				}
				if (prompt === 'fail') {
					controller.error(new Error('Simulated provider failure'));
					return;
				}
				if (prompt === 'burst-edit' && !finishedTool) {
					send({
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: 'todos',
											type: 'function',
											function: {
												name: 'todos_update',
												arguments: JSON.stringify({
													todos: [{ id: 'edit', content: 'Edit the file', status: 'in_progress', priority: 'high' }],
												}),
											},
										},
									],
								},
							},
						],
					});
					send({
						choices: [
							{ delta: { tool_calls: [{ index: 1, id: 'long-edit', type: 'function', function: { name: 'edit', arguments: '' } }] } },
						],
					});
					const argumentsValue = JSON.stringify({
						path: '/workspace/source.txt',
						edits: [{ oldText: 'baseline', newText: 'x'.repeat(16_000) }],
					});
					for (const character of argumentsValue)
						send({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: character } }] } }] });
					send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
					controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
					controller.close();
					return;
				}
				if (finishedTool || prompt === 'hello' || prompt === 'recall') {
					const content =
						prompt === 'recall'
							? input.messages.some((message) => message.role === 'user' && message.content === 'Previous request')
								? 'Earlier request retained'
								: 'History missing'
							: 'Session completed';
					send({ choices: [{ delta: { content }, finish_reason: 'stop' }] });
				} else {
					send({
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: 'write-1',
											type: 'function',
											function: {
												name: 'write',
												arguments: JSON.stringify({ path: '/workspace/source.txt', content: 'saved by agent' }),
											},
										},
									],
								},
								finish_reason: 'tool_calls',
							},
						],
					});
				}
				controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
				controller.close();
			},
			// Deliberately model an upstream transport that never acknowledges abort.
			cancel() {
				clearInterval(heartbeat);
				return new Promise<void>(() => {});
			},
		});
		return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
	}
}

interface FixtureEnvironment {
	AgentRunner: DurableObjectNamespace<AgentRunner>;
	DurableObjectFilesystem: Env['DurableObjectFilesystem'];
	DB: D1Database;
}

const submitSchema = z.object({ messageId: z.string(), prompt: z.string() });

export default {
	async fetch(request: Request, environment: FixtureEnvironment): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/provider-started')
			return Response.json({ started: startedModelRequests.has(url.searchParams.get('prompt') ?? '') });
		if (url.pathname === '/project') {
			await environment.DB.exec(
				'CREATE TABLE IF NOT EXISTS project (id TEXT PRIMARY KEY, organization_id TEXT, deleted_at TEXT, banned_at TEXT)',
			);
			const identifier = environment.DurableObjectFilesystem.newUniqueId();
			await environment.DurableObjectFilesystem.get(identifier).writeFileContent('/source.txt', 'baseline');
			return Response.json({ projectId: BigInt(`0x${identifier}`).toString(36) });
		}
		const projectId = z.string().min(1).parse(url.searchParams.get('project'));
		const sessionId = url.searchParams.get('session') ?? 'session';
		const parent = environment.AgentRunner.getByName(`agent:${projectId}`);
		await parent.setName(`agent:${projectId}`);
		if (url.pathname === '/file') {
			const filesystem = environment.DurableObjectFilesystem.get(environment.DurableObjectFilesystem.idFromString(toHex(projectId)));
			return Response.json({ content: await filesystem.wsReadFile('/source.txt') });
		}
		if (url.pathname === '/submit') {
			const input = submitSchema.parse(await request.json());
			return Response.json(
				await parent.submitMessage({
					sessionId,
					messageId: input.messageId,
					createdAt: Date.now(),
					mode: 'code',
					parts: [{ type: 'text', content: input.prompt }],
				}),
			);
		}
		if (url.pathname === '/stop') {
			await parent.abortRun(sessionId);
			return Response.json({ stopped: true });
		}
		if (url.pathname === '/evict') {
			await parent.evictForTest();
			return new Response('evicted');
		}
		if (url.pathname === '/state') return Response.json(await parent.readTestState());
		if (url.pathname === '/traffic') return Response.json(await parent.readTestTraffic());
		if (url.pathname === '/block-completion') {
			await parent.blockCompletionForTest();
			return Response.json({ blocked: true });
		}
		if (url.pathname === '/restore-completion') {
			await parent.restoreCompletionForTest();
			return Response.json({ restored: true });
		}
		if (url.pathname === '/recovery-watch') return Response.json({ scheduled: await parent.hasRecoveryWatchForTest() });
		if (url.pathname === '/submission')
			return Response.json(await parent.inspectTestSubmission(sessionId, url.searchParams.get('message') ?? 'message'));
		if (url.pathname === '/fork') {
			await parent.revertSession(sessionId, 1);
			return Response.json({ sessionId: await parent.readTestSessionId() });
		}
		if (url.pathname === '/seed-history') {
			const history: ChatMessage[] = [
				{ id: 'old-user', role: 'user', parts: [{ type: 'text', content: 'Previous request' }] },
				{ id: 'old-assistant', role: 'assistant', parts: [{ type: 'text', content: 'Previous answer' }] },
			];
			await parent.seedTestHistory(sessionId, history);
			return Response.json({ seeded: true });
		}
		using session = await parent.readSession(sessionId);
		return Response.json(session ?? {});
	},
};
