import { z } from 'zod';

import type { TodoItem } from './types';
import type { ChatMessage } from '@shared/types';

const MAX_EVIDENCE_CHARACTERS = 32_000;
const probabilitySchema = z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) }).transform((answer) => answer.noul);
const responseSchema = z.object({
	answers: z.object({ complete: probabilitySchema, needs_user: probabilitySchema, unsupported_claims: probabilitySchema }),
});

interface ReviewObservation {
	id: string;
	toolName: string;
	input: string;
	output: string;
	failed: boolean;
	succeeded: boolean;
	revision: number;
}

export interface CompletionReviewContext {
	messages: ChatMessage[];
	changedPaths: string[];
	todos: TodoItem[];
	observations: ReviewObservation[];
	revision: number;
	incomplete: boolean;
}

interface ReviewFinding {
	message: string;
	evidence: string[];
}

interface CompletionReviewResult {
	recommendation: 'ready' | 'continue' | 'needs_user' | 'unknown';
	confidence: number;
	evidence: string[];
	findings: ReviewFinding[];
}

export class CompletionReviewRecorder {
	observations: ReviewObservation[] = [];
	revision = 0;
	incomplete = false;
	private characters = 0;
	private serialize(value: unknown): string {
		try {
			return JSON.stringify(value) ?? '';
		} catch {
			this.incomplete = true;
			return '[unavailable evidence]';
		}
	}

	record(toolName: string, input: unknown, output: unknown, failed = false): void {
		if (toolName === 'completion_review') return;
		if (
			!['exec', 'bash', 'test_run', 'lint_check', 'dependencies_list', 'dependencies_update', 'todos_update'].includes(toolName) &&
			!toolName.startsWith('browser_')
		)
			return;
		if (this.observations.length >= 128) {
			this.incomplete = true;
			return;
		}
		const result = z
			.object({
				exitCode: z.number().nullish(),
				error: z.unknown().optional(),
				metadata: z
					.object({
						exitCode: z.number().optional(),
						failed: z.number().optional(),
						issueCount: z.number().optional(),
						diagnostics: z.array(z.object({ severity: z.string() })).optional(),
					})
					.passthrough()
					.optional(),
			})
			.passthrough()
			.safeParse(output);
		const inputText = this.serialize(input);
		const outputText = this.serialize(output);
		const exitCode = result.success ? (result.data.exitCode ?? result.data.metadata?.exitCode) : undefined;
		const remaining = Math.max(0, MAX_EVIDENCE_CHARACTERS - this.characters);
		if (inputText.length + outputText.length > remaining) this.incomplete = true;
		this.observations.push({
			id: `tool:${this.observations.length + 1}`,
			toolName,
			input: inputText.slice(0, remaining),
			output: outputText.slice(0, Math.max(0, remaining - inputText.length)),
			failed:
				failed ||
				(result.success &&
					((exitCode !== undefined && exitCode !== 0) ||
						Boolean(result.data.error) ||
						(result.data.metadata?.failed ?? 0) > 0 ||
						Boolean(result.data.metadata?.diagnostics?.some((diagnostic) => diagnostic.severity === 'error')))),
			succeeded:
				!failed && result.success && (exitCode === 0 || result.data.metadata?.failed === 0 || result.data.metadata?.issueCount === 0),
			revision: this.revision,
		});
		this.characters += inputText.length + outputText.length;
	}
}

export async function reviewCompletion(
	context: CompletionReviewContext,
	draftSummary: string,
	run: (state: string, signal: AbortSignal) => Promise<unknown>,
	abortSignal?: AbortSignal,
): Promise<CompletionReviewResult> {
	abortSignal?.throwIfAborted();
	const references = [
		...context.messages.filter((message) => message.role === 'user').map((message) => `message:${message.id}`),
		...context.observations.map((observation) => observation.id),
		...context.todos.map((todo) => `todo:${todo.id}`),
	];
	const latest = new Map<string, ReviewObservation>();
	for (const observation of context.observations.filter((observation) => observation.failed || observation.succeeded))
		latest.set(`${observation.toolName}:${observation.input}`, observation);
	const failures = [...latest.values()].filter((observation) => observation.failed);
	const findings: ReviewFinding[] = failures.map((observation) => ({
		message: 'This tool failed and has no successful rerun with the same inputs. Investigate or explicitly report the unresolved failure.',
		evidence: [observation.id],
	}));
	const unknown = (message: string): CompletionReviewResult => ({
		recommendation: 'unknown',
		confidence: 0,
		evidence: references,
		findings: [...findings, { message, evidence: [] }],
	});
	const conversation = context.messages.map((message) => ({
		id: `message:${message.id}`,
		role: message.role,
		parts: message.parts.filter((part) => part.type === 'text' || part.type === 'preview-element'),
	}));
	const state = JSON.stringify({
		conversation,
		changedPaths: context.changedPaths,
		todos: context.todos.map((todo) => ({ ...todo, evidence: `todo:${todo.id}` })),
		observations: context.observations,
		currentRevision: context.revision,
		draftSummary,
	});
	if (context.incomplete || state.length > MAX_EVIDENCE_CHARACTERS || !conversation.some((message) => message.role === 'user'))
		return unknown('Review evidence is incomplete. Do not infer that validation passed.');
	const signal = AbortSignal.any([AbortSignal.timeout(2000), ...(abortSignal ? [abortSignal] : [])]);
	try {
		let onAbort: () => void = () => {};
		const interrupted = new Promise<never>((_resolve, reject) => {
			onAbort = () => reject(signal.reason);
			signal.addEventListener('abort', onAbort, { once: true });
		});
		let rawResponse: unknown;
		try {
			signal.throwIfAborted();
			rawResponse = await Promise.race([run(state, signal), interrupted]);
		} finally {
			signal.removeEventListener('abort', onAbort);
		}
		const response = responseSchema.safeParse(rawResponse);
		abortSignal?.throwIfAborted();
		if (!response.success) return unknown('Completion review returned an invalid response.');
		const answers = response.data.answers;
		if (Object.values(answers).some((probability) => probability > 0.2 && probability < 0.8))
			return unknown('Completion review has low confidence. Assess the evidence directly.');
		if (answers.unsupported_claims >= 0.8)
			findings.push({
				message: 'The draft summary appears to claim more than the observed evidence supports. Revise it or gather the missing evidence.',
				evidence: context.observations.map((observation) => observation.id),
			});
		if (failures.length > 0 || answers.unsupported_claims >= 0.8)
			return {
				recommendation: 'continue',
				confidence: failures.length > 0 ? 1 : answers.unsupported_claims,
				evidence: references,
				findings,
			};
		if (answers.needs_user >= 0.8) return { recommendation: 'needs_user', confidence: answers.needs_user, evidence: references, findings };
		if (answers.complete <= 0.2)
			return {
				recommendation: 'continue',
				confidence: 1 - answers.complete,
				evidence: references,
				findings: [
					{
						message: 'The requested work or its verification appears unfinished. Compare the task, TODOs, and observed checks.',
						evidence: [
							...context.todos.filter((todo) => todo.status !== 'completed').map((todo) => `todo:${todo.id}`),
							...context.observations.map((observation) => observation.id),
						],
					},
				],
			};
		if (answers.complete >= 0.8 && answers.unsupported_claims <= 0.2 && answers.needs_user <= 0.2) {
			if (
				context.changedPaths.length > 0 &&
				!context.observations.some(
					(observation) =>
						observation.revision === context.revision &&
						(observation.succeeded || (observation.toolName.startsWith('browser_') && !observation.failed)),
				)
			)
				return unknown('Changed files have no observed successful checks.');
			return {
				recommendation: 'ready',
				confidence: Math.min(answers.complete, 1 - answers.unsupported_claims, 1 - answers.needs_user),
				evidence: references,
				findings,
			};
		}
		return unknown('Completion review has low confidence. Assess the evidence directly.');
	} catch (error) {
		abortSignal?.throwIfAborted();
		return unknown(
			error instanceof Error && error.name === 'TimeoutError' ? 'Completion review timed out.' : 'Completion review is unavailable.',
		);
	}
}
