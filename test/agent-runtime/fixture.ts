import { WorkerEntrypoint, env as fixtureEnvironment } from 'cloudflare:workers';
import { z } from 'zod';

import { toHex } from '../../shared/project-id';
import { ProjectAgent as ApplicationProjectAgent, SessionTurnAgent as ApplicationSessionTurnAgent } from '../../worker/durable';

import type { ChunkContext } from '@cloudflare/think';
export * from '../../worker/durable';
ApplicationProjectAgent.prototype.addMcpServer = async (): Promise<{ id: string; state: 'ready' }> => ({
	id: 'fixture-docs',
	state: 'ready',
});
const aiBinding = fixtureEnvironment.AI;
Reflect.set(fixtureEnvironment, 'AI', { run: (model: string, input: unknown) => Reflect.apply(aiBinding.run, aiBinding, [model, input]) });

export class SessionTurnAgent extends ApplicationSessionTurnAgent {
	private chunks = 0;
	private toolInput = false;
	private taskProgress: unknown;
	override async onProgress(...parameters: Parameters<ApplicationSessionTurnAgent['onProgress']>): Promise<void> {
		this.taskProgress = parameters[1];
		await super.onProgress(...parameters);
	}

	override async onChunk(context: ChunkContext): Promise<void> {
		this.chunks++;
		if (context.chunk.type === 'tool-input-start' || context.chunk.type === 'tool-call') this.toolInput = true;
		await super.onChunk(context);
	}
	readFixtureState(): string {
		return JSON.stringify({
			...this.state,
			...this.ctx.storage.kv.get<Record<string, unknown>>('execution'),
			taskProgress: this.taskProgress,
			chunks: this.chunks,
			hasToolInput: this.toolInput,
		});
	}
	evictFixture(): void {
		this.ctx.abort('Simulated session eviction');
	}
}
export class ProjectAgent extends ApplicationProjectAgent {
	private summaryUpdates = 0;
	override async completeSessionOperation(input: Parameters<ApplicationProjectAgent['completeSessionOperation']>[0]): Promise<void> {
		if (this.ctx.storage.kv.get('fixture-block-completion')) throw new Error('Simulated exhausted completion RPC');
		await super.completeSessionOperation(input);
	}
	override updateSessionSummary(...parameters: Parameters<ApplicationProjectAgent['updateSessionSummary']>): void {
		this.summaryUpdates++;
		super.updateSessionSummary(...parameters);
	}
	blockCompletionForTest(): void {
		this.ctx.storage.kv.put('fixture-block-completion', true);
	}
	async restoreCompletionForTest(sessionId: string): Promise<void> {
		this.ctx.storage.kv.delete('fixture-block-completion');
		const child = await this.dynamicAgents.get(SessionTurnAgent, sessionId);
		await child.flushFinalizations();
	}
	readTestTraffic() {
		return { summaryUpdates: this.summaryUpdates };
	}
	async readTestState(sessionId: string) {
		const child = await this.dynamicAgents.get(SessionTurnAgent, sessionId);
		return child.readFixtureState();
	}
	async inspectTestSubmission(sessionId: string, submissionId: string) {
		const child = await this.dynamicAgents.get(SessionTurnAgent, sessionId);
		return child.inspectSubmission(submissionId);
	}
	async evictForTest(sessionId: string): Promise<void> {
		const child = await this.dynamicAgents.get(SessionTurnAgent, sessionId);
		await child.evictFixture();
	}
	async seedTestHistory(sessionId: string): Promise<void> {
		await this.createSession({
			id: sessionId,
			projectId: this.name.slice(6),
			requestOriginContext: { appOrigin: 'https://example.com', contentOrigin: 'https://content.example.net' },
		});
		const child = await this.dynamicAgents.get(SessionTurnAgent, sessionId);
		await child.addMessages([
			{
				id: 'old-user',
				role: 'user',
				metadata: { createdAt: 123_000, authorUserId: 'original-author', snapshotId: 'original-review' },
				parts: [{ type: 'text', text: 'Previous request' }],
			},
			{ id: 'old-assistant', role: 'assistant', parts: [{ type: 'text', text: 'Previous answer'.repeat(1000) }] },
		]);
	}
}

const inputSchema = z.object({
	stream: z.boolean().optional(),
	messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
});
const startedModelRequests = new Set<string>();
const notifications: Array<{ userId: string; tag?: string }> = [];
let failNotifications = false;

export class FixturePush extends WorkerEntrypoint {
	async notifyUser(userId: string, notification: { tag?: string }): Promise<void> {
		if (failNotifications) throw new Error('Simulated push delivery failure');
		notifications.push({ userId, tag: notification.tag });
	}
}

export class FixtureAI extends WorkerEntrypoint {
	async run(_model: string, rawInput: unknown) {
		const input = inputSchema.parse(rawInput);
		if (!input.stream) return Response.json({ response: 'Lifecycle test' });
		const prompt = String(input.messages.findLast((message) => message.role === 'user')?.content);
		startedModelRequests.add(prompt);
		if (prompt === 'stall-start') await new Promise((resolve) => setTimeout(resolve, 60_000));
		const finishedTool = input.messages.at(-1)?.role === 'tool';
		if (prompt === 'delegate-output' && finishedTool) await new Promise((resolve) => setTimeout(resolve, 1000));
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
				if (prompt === 'delegate-output' && !finishedTool) {
					send({
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: 'delegate',
											type: 'function',
											function: { name: 'sub_agent', arguments: JSON.stringify({ prompt: 'codemode-output' }) },
										},
									],
								},
								finish_reason: 'tool_calls',
							},
						],
					});
					controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
					controller.close();
					return;
				}
				const codeModeScenarios: Record<string, string> = {
					'codemode-output':
						'const first = await tools.exec({command:"printf first",backend:"shell"}); await new Promise(resolve => setTimeout(resolve, 1000)); const second = await tools.exec({command:"printf second",backend:"shell"}); await new Promise(resolve => setTimeout(resolve, 1000)); return {first, second};',
					'codemode-failure':
						'for (let index = 0; index < 3; index++) { await tools.exec({command:"exit 7",backend:"shell"}); } await tools.write({path:"/source.txt",content:"must not execute"}); return "unexpected";',
					'codemode-progress':
						'for (let index = 0; index < 3; index++) { await tools.exec({command:"exit 7",backend:"shell"}); await tools.write({path:"/source.txt",content:"progress-"+index}); } return "done";',
					'state-failure':
						'for (let index = 0; index < 3; index++) { try { await tools.write({path:"/package.json",content:"{}"}); } catch {} } await tools.write({path:"/source.txt",content:"must not execute"}); return "unexpected";',
				};
				const code = codeModeScenarios[prompt];
				if ((code && !finishedTool) || prompt === 'repeat-failure') {
					send({
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: code ? 'codemode-call' : `failure-${input.messages.length}`,
											type: 'function',
											function: {
												name: code ? 'codemode' : 'exec',
												arguments: JSON.stringify(code ? { code } : { command: 'exit 7', backend: 'shell' }),
											},
										},
									],
								},
								finish_reason: 'tool_calls',
							},
						],
					});
					controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
					controller.close();
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
	ProjectAgent: DurableObjectNamespace<ProjectAgent>;
	DurableObjectFilesystem: Env['DurableObjectFilesystem'];
	DB: D1Database;
}
const submitSchema = z.object({ messageId: z.string(), prompt: z.string() });
export default {
	async fetch(request: Request, environment: FixtureEnvironment): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/provider-started')
			return Response.json({ started: startedModelRequests.has(url.searchParams.get('prompt') ?? '') });
		if (url.pathname === '/notifications') return Response.json(notifications);
		if (url.pathname === '/fail-notifications') {
			failNotifications = true;
			return Response.json({ failed: true });
		}
		if (url.pathname === '/enable-notifications') {
			failNotifications = false;
			return Response.json({ failed: false });
		}
		if (url.pathname === '/project') {
			const identifier = environment.DurableObjectFilesystem.newUniqueId();
			await environment.DurableObjectFilesystem.get(identifier).writeFileContent('/source.txt', 'baseline');
			return Response.json({ projectId: BigInt(`0x${identifier}`).toString(36) });
		}
		const projectId = z.string().min(1).parse(url.searchParams.get('project'));
		const sessionId = url.searchParams.get('session') ?? 'session';
		const parent = environment.ProjectAgent.getByName(`agent:${projectId}`);
		await parent.prepareProject();
		if (url.pathname === '/chat') {
			const headers = new Headers(request.headers);
			headers.set('x-worker-ide-user-id', 'original-author');
			headers.set('x-partykit-room', `agent:${projectId}`);
			url.pathname = `/sub/session-turn-agent/${sessionId}`;
			return parent.fetch(new Request(url, { headers }));
		}
		if (url.pathname === '/delete') {
			await parent.deleteSession(sessionId);
			return Response.json({ deleted: true });
		}
		if (url.pathname === '/branches')
			return Response.json(await parent.sessionBranches(sessionId, url.searchParams.get('message') ?? 'old-user'));
		if (url.pathname === '/file') {
			const filesystem = environment.DurableObjectFilesystem.get(environment.DurableObjectFilesystem.idFromString(toHex(projectId)));
			return Response.json({ content: await filesystem.wsReadFile('/source.txt') });
		}
		if (url.pathname === '/submit') {
			const input = submitSchema.parse(await request.json());
			await parent.createSession({
				id: sessionId,
				projectId,
				requestOriginContext: { appOrigin: 'https://example.com', contentOrigin: 'https://content.example.net' },
			});
			return Response.json(
				await parent.submitMessage(sessionId, {
					id: input.messageId,
					role: 'user',
					metadata: { createdAt: Date.now(), submissionId: input.messageId },
					parts: [{ type: 'text', text: input.prompt }],
				}),
			);
		}
		if (url.pathname === '/stop') {
			await parent.cancelSession(sessionId);
			return Response.json({ stopped: true });
		}
		if (url.pathname === '/evict') {
			await parent.evictForTest(sessionId);
			return new Response('evicted');
		}
		if (url.pathname === '/state' || url.pathname === '/reload-session')
			return new Response(await parent.readTestState(sessionId), { headers: { 'Content-Type': 'application/json' } });
		if (url.pathname === '/debug-log') {
			const state = z.object({ debugLogId: z.string() }).safeParse(JSON.parse(await parent.readTestState(sessionId)));
			if (!state.success) return new Response('No debug log', { status: 404 });
			const filesystem = environment.DurableObjectFilesystem.get(environment.DurableObjectFilesystem.idFromString(toHex(projectId)));
			return new Response(await filesystem.wsReadFile(`/.agent/sessions/${sessionId}/debug-logs/${state.data.debugLogId}.json`), {
				headers: { 'Content-Type': 'application/json' },
			});
		}
		if (url.pathname === '/traffic') return Response.json(await parent.readTestTraffic());
		if (url.pathname === '/block-completion') {
			await parent.blockCompletionForTest();
			return Response.json({ blocked: true });
		}
		if (url.pathname === '/restore-completion') {
			await parent.restoreCompletionForTest(sessionId);
			return Response.json({ restored: true });
		}
		if (url.pathname === '/submission')
			return Response.json(await parent.inspectTestSubmission(sessionId, url.searchParams.get('message') ?? 'message'));
		if (url.pathname === '/seed-history') {
			await parent.seedTestHistory(sessionId);
			return Response.json({ seeded: true });
		}
		const state: unknown = JSON.parse(await parent.readTestState(sessionId));
		const history = z.object({ messages: z.array(z.unknown()) }).parse(JSON.parse(await parent.readSessionHistory(sessionId)));
		return Response.json({ ...z.record(z.string(), z.unknown()).parse(state), history: history.messages });
	},
};
