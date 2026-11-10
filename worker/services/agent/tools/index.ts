import { Validator } from '@cfworker/json-schema';
import { createCodemodeRuntime, DynamicWorkerExecutor, truncateResult } from '@cloudflare/codemode';
import { ToolSetConnector } from '@cloudflare/codemode/ai';
import { asSchema, jsonSchema } from 'ai';
import { z } from 'zod';

import { ToolExecutionError } from '@shared/tool-errors';
import { runWithProjectStub } from '@worker/lib/project-fs';

import { cancellableWorkerLoader } from '../cancellable-worker-loader';
import { CompletionReviewRecorder } from '../completion-review';
import { readTodos } from '../tool-executor';
import { toolOutputError } from '../tool-failure-guard';
import * as assetSettingsGetTool from './asset-settings-get';
import * as assetSettingsUpdateTool from './asset-settings-update';
import * as bindingsGetTool from './bindings-get';
import * as bindingsUpdateTool from './bindings-update';
import { createPreviewBrowserTools } from './browser-tools';
import * as completionReviewTool from './completion-review';
import { createComputerTools } from './computer-tools';
import * as dependenciesListTool from './dependencies-list';
import * as dependenciesUpdateTool from './dependencies-update';
import * as documentationSearchTool from './documentation-search';
import { drainWorkspaceChanges } from './drain-workspace-changes';
import * as imageGenerateTool from './image-generate';
import * as lintCheckTool from './lint-check';
import * as lintFixTool from './lint-fix';
import * as planUpdateTool from './plan-update';
import * as previewFetchTool from './preview-fetch';
import * as subAgentTool from './sub-agent';
import * as testRunTool from './test-run';
import * as todosGetTool from './todos-get';
import * as todosUpdateTool from './todos-update';
import * as userQuestionTool from './user-question';
import { closeToolInputSchema, coerceToObject, validateAndCoerceToolInput } from './validate-tool-input';
import * as webFetchTool from './web-fetch';
import { withSpan } from '../../../lib/tracing';
import { sanitizeToolInput, summarizeToolResult } from '../agent-logger';
import { createConfiguredMcpConnectors } from '../mcp';

import type { AgentLogger } from '../agent-logger';
import type { CompletionReviewContext } from '../completion-review';
import type { FileChange, SendEventFunction, ToolDefinition, ToolExecuteFunction, ToolExecutorContext } from '../types';
import type { ToolSet } from 'ai';

export const TOOL_EXECUTORS: ReadonlyMap<string, ToolExecuteFunction> = new Map([
	['completion_review', completionReviewTool.execute],
	['user_question', userQuestionTool.execute],
	['web_fetch', webFetchTool.execute],
	['docs_search', documentationSearchTool.execute],
	['plan_update', planUpdateTool.execute],
	['todos_get', todosGetTool.execute],
	['todos_update', todosUpdateTool.execute],
	['dependencies_list', dependenciesListTool.execute],
	['dependencies_update', dependenciesUpdateTool.execute],
	['asset_settings_get', assetSettingsGetTool.execute],
	['asset_settings_update', assetSettingsUpdateTool.execute],
	['bindings_get', bindingsGetTool.execute],
	['bindings_update', bindingsUpdateTool.execute],
	['lint_check', lintCheckTool.execute],
	['lint_fix', lintFixTool.execute],
	['preview_fetch', previewFetchTool.execute],
	['test_run', testRunTool.execute],
	['image_generate', imageGenerateTool.execute],
	['sub_agent', subAgentTool.execute],
]);

export const AGENT_TOOLS: readonly ToolDefinition[] = [
	completionReviewTool.definition,
	userQuestionTool.definition,
	webFetchTool.definition,
	documentationSearchTool.definition,
	planUpdateTool.definition,
	todosGetTool.definition,
	todosUpdateTool.definition,
	dependenciesListTool.definition,
	dependenciesUpdateTool.definition,
	assetSettingsGetTool.definition,
	assetSettingsUpdateTool.definition,
	bindingsGetTool.definition,
	bindingsUpdateTool.definition,
	lintCheckTool.definition,
	lintFixTool.definition,
	previewFetchTool.definition,
	testRunTool.definition,
	imageGenerateTool.definition,
	subAgentTool.definition,
];

const DEFINITIONS_BY_NAME: ReadonlyMap<string, ToolDefinition> = new Map(AGENT_TOOLS.map((definition) => [definition.name, definition]));

/**
 * Tools the model calls directly (outside Code Mode): they pause for user
 * input or drive durable UI panels, so they cannot run inside the sandbox.
 */
const DIRECT_TOOL_NAMES = new Set(['user_question', 'plan_update', 'todos_get', 'todos_update', 'sub_agent']);

const DIRECT_COMPANION_TOOL_NAMES = new Set(['dependencies_list', 'dependencies_update', 'completion_review']);

const PLAN_MODE_TOOL_NAMES = new Set([
	'user_question',
	'web_fetch',
	'docs_search',
	'plan_update',
	'todos_get',
	'todos_update',
	'dependencies_list',
	'asset_settings_get',
	'bindings_get',
	'lint_check',
	'preview_fetch',
	'test_run',
]);

export const PLAN_MODE_TOOLS: readonly ToolDefinition[] = AGENT_TOOLS.filter((t) => PLAN_MODE_TOOL_NAMES.has(t.name));

const ASK_MODE_TOOL_NAMES = new Set([
	'user_question',
	'web_fetch',
	'docs_search',
	'dependencies_list',
	'asset_settings_get',
	'bindings_get',
	'lint_check',
	'preview_fetch',
	'test_run',
]);

export const ASK_MODE_TOOLS: readonly ToolDefinition[] = AGENT_TOOLS.filter((t) => ASK_MODE_TOOL_NAMES.has(t.name));

const EDITING_TOOL_NAMES = new Set(['lint_fix', 'image_generate']);

/**
 * Tools excluded from sub-agent runs.
 * - sub_agent: prevents recursive spawning
 * - user_question: sub-agents cannot interact with the user
 * - plan/todos tools: sub-agents are ephemeral and should report back to the
 *   root agent instead of creating durable task state of their own
 */
export const SUB_AGENT_EXCLUDED_TOOLS = new Set([
	'sub_agent',
	'user_question',
	'plan_update',
	'todos_get',
	'todos_update',
	'completion_review',
]);

/**
 * Mutation tool names — tools that modify files or project state.
 * Used by the doom loop detector and logging to track mutation activity.
 */
export const MUTATION_TOOL_NAMES = new Set([
	'write',
	'edit',
	'delete',
	'exec',
	'lint_fix',
	'dependencies_update',
	'asset_settings_update',
	'bindings_update',
	'image_generate',
]);

type AnyTool = ToolSet[string];

/** Build Code Mode from the same guarded leaf catalog used by direct calls. */
export async function createServerTools(
	sendEvent: SendEventFunction,
	inputContext: ToolExecutorContext,
	queryChanges: FileChange[],
	mode: 'code' | 'plan' | 'ask',
	logger?: AgentLogger,
	excludedToolNames?: ReadonlySet<string>,
): Promise<ToolSet> {
	const {
		directTools: llmTools,
		nestedTools: codeModeTools,
		context,
		sendEvent: trackedSendEvent,
	} = await createAgentToolCatalog(sendEvent, inputContext, queryChanges, mode, logger, excludedToolNames);
	if (!context.ctx || !context.loader) throw new Error('Agent Code Mode requires its Durable Object and Worker Loader.');
	const connectors = await createConfiguredMcpConnectors(context);
	const runtime = createCodemodeRuntime({
		ctx: context.ctx,
		name: 'agent-tools',
		connectors: [new ToolSetConnector(context.ctx, { tools: codeModeTools }), ...connectors],
		executor: new DynamicWorkerExecutor({
			loader: cancellableWorkerLoader(context.loader, () => context.activeCodeMode?.abortSignal ?? context.abortSignal),
			timeout: 360_000,
			// eslint-disable-next-line unicorn/no-null -- The SDK requires null to disable outbound access.
			globalOutbound: null,
		}),
		transformResult: truncateResult,
	});
	const tool = runtime.tool();
	const wrapped = wrapCodemodeTool(tool, context, trackedSendEvent, queryChanges);
	const execute = wrapped.execute;
	if (typeof execute !== 'function') throw new Error('CodeMode executor is unavailable');
	let tail = Promise.resolve();
	llmTools.codemode = {
		...wrapped,
		execute: async (input: unknown, options: { toolCallId?: string; abortSignal?: AbortSignal }) => {
			const previous = tail;
			const release = Promise.withResolvers<void>();
			tail = release.promise;
			await previous;
			const toolCallId = options?.toolCallId ?? crypto.randomUUID();
			context.activeCodeMode = { toolCallId, abortSignal: options?.abortSignal };
			const observedBefore = context.failureGuard?.observationVersion;
			try {
				context.failureGuard?.assertHealthy();
				const output: unknown = await Reflect.apply(execute, wrapped, [input, options]);
				if (context.failureGuard?.observationVersion === observedBefore)
					context.failureGuard?.record({ id: toolCallId, toolName: 'codemode', input, error: toolOutputError(output) });
				return output;
			} catch (error) {
				if (context.failureGuard?.observationVersion === observedBefore)
					context.failureGuard?.record({ id: toolCallId, toolName: 'codemode', input, error: String(error) });
				throw error;
			} finally {
				context.failureGuard?.ignore(toolCallId);
				context.activeCodeMode = undefined;
				release.resolve();
			}
		},
	};
	return llmTools;
}

export async function createAgentToolCatalog(
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
	queryChanges: FileChange[],
	mode: 'code' | 'plan' | 'ask',
	logger?: AgentLogger,
	excludedToolNames?: ReadonlySet<string>,
): Promise<{ directTools: ToolSet; nestedTools: ToolSet; context: ToolExecutorContext; sendEvent: SendEventFunction }> {
	const recorder = new CompletionReviewRecorder();
	const readCompletionReviewContext = context.readCompletionReviewContext;
	context = {
		...context,
		recordReviewObservation: (name, input, output, failed) => recorder.record(name, input, output, failed),
		readCompletionReviewContext: readCompletionReviewContext
			? async () => {
					let evidence: CompletionReviewContext;
					try {
						await drainWorkspaceChanges(context, trackedSendEvent, queryChanges);
						evidence = {
							...(await readCompletionReviewContext()),
							todos: await runWithProjectStub(
								context.fsStub,
								() => readTodos(context.projectRoot, context.sessionId, true),
								context.projectRoot,
								context.sessionId,
							),
						};
					} catch {
						evidence = { messages: [], changedPaths: [], todos: [], observations: [], revision: 0, incomplete: true };
					}
					return {
						...evidence,
						observations: [...recorder.observations],
						revision: recorder.revision,
						incomplete: evidence.incomplete || recorder.incomplete,
						changedPaths: [...new Set([...evidence.changedPaths, ...queryChanges.map((change) => change.path)])],
					};
				}
			: undefined,
		sessionId: context.sessionId ?? `agent:${context.projectId}`,
	};
	await context.fsStub.registerComputerSession(context.sessionId ?? `agent:${context.projectId}`, mode, context.requestOriginContext);
	// Suppress identical notifications, while preserving every later revision.
	const emittedChanges = new Map<string, Record<string, unknown>>();
	const trackedSendEvent: SendEventFunction = (type, data) => {
		if (type === 'file_changed' && typeof data.path === 'string') {
			const previous = emittedChanges.get(data.path);
			if (
				previous &&
				['action', 'beforeContent', 'afterContent', 'beforeBytes', 'afterBytes', 'entryType', 'beforeEntryType'].every(
					(key) => previous[key] === data[key],
				)
			)
				return;
			emittedChanges.set(data.path, data);
			recorder.revision++;
			context.failureGuard?.progress();
		}
		sendEvent(type, data);
	};

	const isExcluded = (name: string): boolean =>
		Boolean(excludedToolNames?.has(name)) || (name === 'completion_review' && Boolean(context.isSubAgent));
	const wrapDeps = (events: SendEventFunction): WrapDeps => ({ sendEvent: events, context, queryChanges, mode, logger });

	const llmTools: ToolSet = {};

	// 1. Direct interactive tools.
	for (const name of directToolNames(mode)) {
		if (isExcluded(name)) continue;
		const definition = DEFINITIONS_BY_NAME.get(name);
		const executor = TOOL_EXECUTORS.get(name);
		if (definition && executor) {
			llmTools[name] = wrapTool(definition, executor, wrapDeps(sendEvent));
		}
	}

	// 2. Code Mode `tools.*` — domain tools, MCP tools and browser tools.
	const codeModeTools: ToolSet = {};
	for (const [name, definition] of Object.entries(createComputerTools(context, mode))) {
		if (isExcluded(name)) continue;
		const wrapped = wrapCodemodeTool(definition, context, trackedSendEvent, queryChanges, name);
		codeModeTools[name] = wrapped;
		llmTools[name] = wrapped;
	}
	for (const name of codeModeToolNames(mode)) {
		if (isExcluded(name)) continue;
		const definition = DEFINITIONS_BY_NAME.get(name);
		const executor = TOOL_EXECUTORS.get(name);
		if (definition && executor) {
			const wrapped = wrapTool(definition, executor, wrapDeps(trackedSendEvent));
			codeModeTools[name] = wrapped;
			if (DIRECT_COMPANION_TOOL_NAMES.has(name)) {
				llmTools[name] = wrapDirectTool(wrapped, context, trackedSendEvent, queryChanges);
			}
		}
	}

	Object.assign(codeModeTools, await createPreviewBrowserTools(context, mode));
	for (const [name, definition] of Object.entries(codeModeTools)) {
		if (name === 'browser' || name.startsWith('browser_')) codeModeTools[name] = wrapObservedTool(definition, name, context);
	}

	// Observe leaf calls on both surfaces. CodeMode validates before invoking execute.
	for (const [name, definition] of Object.entries(codeModeTools)) {
		const observed = observeHarnessTool(definition, name, context);
		codeModeTools[name] = observed;
		if (llmTools[name] === definition) llmTools[name] = observed;
	}
	for (const name of directToolNames(mode)) if (llmTools[name]) llmTools[name] = observeHarnessTool(llmTools[name], name, context);

	return { directTools: llmTools, nestedTools: codeModeTools, context, sendEvent: trackedSendEvent };
}

interface WrapDeps {
	sendEvent: SendEventFunction;
	context: ToolExecutorContext;
	queryChanges: FileChange[];
	mode: 'code' | 'plan' | 'ask';
	logger?: AgentLogger;
}

/** Names of the direct (non-Code-Mode) tools available in a given mode. */
function directToolNames(mode: 'code' | 'plan' | 'ask'): string[] {
	if (mode === 'ask') return [...DIRECT_TOOL_NAMES].filter((name) => ASK_MODE_TOOL_NAMES.has(name));
	if (mode === 'plan') return [...DIRECT_TOOL_NAMES].filter((name) => PLAN_MODE_TOOL_NAMES.has(name));
	return [...DIRECT_TOOL_NAMES];
}

/** Names of the tools exposed inside Code Mode as `tools.*` for a given mode. */
function codeModeToolNames(mode: 'code' | 'plan' | 'ask'): string[] {
	const base = mode === 'ask' ? ASK_MODE_TOOL_NAMES : mode === 'plan' ? PLAN_MODE_TOOL_NAMES : new Set(AGENT_TOOLS.map((t) => t.name));
	return [...base].filter((name) => !DIRECT_TOOL_NAMES.has(name));
}

/**
 * After each tool, reflect authoritative workspace revisions
 * back to the UI (file-change events, preview HMR, snapshots). Writes already
 * surfaced by a `tools.*` call are skipped.
 */
function wrapCodemodeTool<T extends AnyTool>(
	tool: T,
	context: ToolExecutorContext,
	sendEvent: SendEventFunction,
	queryChanges: FileChange[],
	computerToolName?: string,
): T {
	const originalExecute = tool.execute;
	if (typeof originalExecute !== 'function') return tool;
	return {
		...tool,
		execute: async (input: unknown, options: unknown) => {
			try {
				const output: unknown = await Reflect.apply(originalExecute, tool, [input, options]);
				if (computerToolName) context.recordReviewObservation?.(computerToolName, input, output);
				if (computerToolName) {
					const record = output && typeof output === 'object' ? output : {};
					const argumentsValue = input && typeof input === 'object' ? input : {};
					const metadata = Object.fromEntries(
						Object.entries(record).filter(([key]) =>
							['backend', 'exitCode', 'error', 'status', 'syncStatus', 'path', 'kind', 'sizeBytes'].includes(key),
						),
					);
					sendEvent('tool_result', {
						tool_name: computerToolName,
						toolCallId: options && typeof options === 'object' && 'toolCallId' in options ? options.toolCallId : context.toolCallId,
						title: 'path' in argumentsValue ? argumentsValue.path : computerToolName,
						metadata,
					});
				}
				return output;
			} catch (error) {
				if (computerToolName) context.recordReviewObservation?.(computerToolName, input, String(error), true);
				throw error;
			} finally {
				await drainWorkspaceChanges(context, sendEvent, queryChanges);
			}
		},
	};
}

/**
 * Direct tools run in this context and push their own changes into
 * `queryChanges`. A post-run drain surfaces changes from tools that report
 * them only through the drain (e.g. dependencies_update), deduping paths the
 * tool already recorded to avoid double entries.
 */
function wrapDirectTool(tool: AnyTool, context: ToolExecutorContext, sendEvent: SendEventFunction, queryChanges: FileChange[]): AnyTool {
	const originalExecute = tool.execute;
	if (typeof originalExecute !== 'function') return tool;
	return {
		...tool,
		execute: async (input: unknown, options: unknown) => {
			const changeIndex = queryChanges.length;
			try {
				return await Reflect.apply(originalExecute, tool, [input, options]);
			} finally {
				// Snapshot AFTER the tool ran: these paths (including the tool's own
				// pushes) must not be re-recorded by the drain.
				const alreadyRecorded = new Set(queryChanges.slice(changeIndex).map((change) => change.path));
				await drainWorkspaceChanges(context, sendEvent, queryChanges, undefined, alreadyRecorded);
			}
		},
	};
}

/**
 * Convert a {@link ToolDefinition} + executor into an AI SDK tool: validate and
 * string-coerce input, enforce mode gating, log, emit `tool_result`, and feed
 * the turn's repeated-failure guard.
 */
function wrapTool(definition: ToolDefinition, executor: ToolExecuteFunction, deps: WrapDeps): AnyTool {
	const { sendEvent, context, queryChanges, mode, logger } = deps;
	const toolName = definition.name;

	// A `validate` function is required so the AI SDK runs input validation
	// (and `experimental_repairToolCall` fires) for hallucinated property names.
	// In Code Mode this same `validate` runs inside the codemode sandbox for
	// every `tools.*` call, where there is NO repair step — so it coerces loose
	// input and reports the expected schema on failure (see validate-tool-input).
	const schema = jsonSchema<Record<string, string>>(closeToolInputSchema(definition.input_schema), {
		validate: (value) => validateAndCoerceToolInput(toolName, definition.input_schema, value),
	});

	return {
		description: definition.description,
		inputSchema: schema,
		outputSchema: z.object({ title: z.string(), metadata: z.record(z.string(), z.unknown()), output: z.string() }),
		toModelOutput: ({ output }: { output: unknown }): { type: 'text'; value: string } => ({
			type: 'text',
			value: z.object({ output: z.string() }).parse(output).output,
		}),
		execute: async (
			input: Record<string, string>,
			executeOptions?: { toolCallId?: string; abortSignal?: AbortSignal; harnessOutcomeId?: string },
		) => {
			const signals = [context.abortSignal, executeOptions?.abortSignal].filter((signal) => signal !== undefined);
			const abortSignal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
			abortSignal?.throwIfAborted();

			const callContext: ToolExecutorContext = { ...context, toolName, toolCallId: executeOptions?.toolCallId, abortSignal };

			// Defense-in-depth: reject editing tools in non-code modes.
			if (mode !== 'code' && EDITING_TOOL_NAMES.has(toolName)) {
				logger?.warn('tool_call', 'blocked', { toolName, reason: 'editing_tool_in_non_code_mode', mode });
				throw new ToolExecutionError('NOT_ALLOWED', 'File editing tools are not available in this mode.');
			}

			logger?.info('tool_call', 'started', { toolName, input: sanitizeToolInput(input) });
			const timer = logger?.startTimer();

			try {
				// Re-bind the project filesystem for the executor. In Code Mode a
				// `tools.*` call is dispatched from the sandbox via an inbound Workers
				// RPC into the codemode runtime facet — a fresh I/O context that does
				// NOT inherit the `runWithProjectStub` AsyncLocalStorage store the
				// agent loop established. Without this, tools that read/write through
				// the `fs` proxy (readDependencies, protected files, …) would see an
				// unbound filesystem and silently fail (e.g. dependencies_list
				// returning "No dependencies registered"). The fsStub is a DO stub, so
				// re-binding works across contexts and is a harmless no-op for direct
				// tools already inside the agent-loop scope.
				const result = await withSpan(
					`tool.${toolName}`,
					() =>
						runWithProjectStub(
							context.fsStub,
							() => executor(input, sendEvent, callContext, queryChanges),
							context.projectRoot,
							context.sessionId,
						),
					{ 'tool.name': toolName, 'agent.mode': mode },
				);
				context.recordReviewObservation?.(toolName, input, result);
				context.failureGuard?.record({
					id: executeOptions?.harnessOutcomeId ?? executeOptions?.toolCallId ?? crypto.randomUUID(),
					toolName,
					input,
					error: toolOutputError(result),
				});
				logger?.info(
					'tool_call',
					'completed',
					{ toolName, resultSummary: summarizeToolResult(result.output), resultLength: result.output.length },
					{ durationMs: timer?.() },
				);
				sendEvent('tool_result', {
					toolCallId: executeOptions?.toolCallId,
					tool_name: toolName,
					title: result.title,
					metadata: result.metadata,
				});
				return result;
			} catch (error) {
				context.recordReviewObservation?.(toolName, input, String(error), true);
				const isToolError = error instanceof ToolExecutionError;
				logger?.[isToolError ? 'warn' : 'error'](
					'tool_call',
					isToolError ? 'tool_error' : 'error',
					{
						toolName,
						errorCode: isToolError ? error.code : undefined,
						error: error instanceof Error ? error.message : String(error),
						stack: isToolError ? undefined : error instanceof Error ? error.stack : undefined,
					},
					{ durationMs: timer?.() },
				);
				throw error;
			}
		},
	};
}

function wrapObservedTool(definition: AnyTool, name: string, context: ToolExecutorContext): AnyTool {
	const execute = definition.execute;
	if (typeof execute !== 'function') return definition;
	return {
		...definition,
		execute: async (input: unknown, options: unknown) => {
			try {
				const output: unknown = await Reflect.apply(execute, definition, [input, options]);
				context.recordReviewObservation?.(name, input, output);
				return output;
			} catch (error) {
				context.recordReviewObservation?.(name, input, String(error), true);
				throw error;
			}
		},
	};
}

/** Keep leaf failures observable even when sandbox code catches them. */
function observeHarnessTool(definition: AnyTool, name: string, context: ToolExecutorContext): AnyTool {
	const execute = definition.execute;
	if (typeof execute !== 'function') return definition;
	const schema = definition.inputSchema ? asSchema(definition.inputSchema) : undefined;
	return {
		...definition,
		...(schema
			? {
					inputSchema: jsonSchema(schema.jsonSchema, {
						validate: async (input) => {
							context.failureGuard?.assertHealthy();
							const normalized = coerceToObject(input);
							const declaredSchema = await schema.jsonSchema;
							// Schemas come from SDK tool definitions; validate values before a Zod
							// parser can strip unknown keys or a domain adapter stringifies them.
							if (!declaredSchema || typeof declaredSchema !== 'object') throw new Error(`Missing schema for ${name}`);
							const validation = validateDeclaredInput(declaredSchema, normalized);
							const result =
								validation && !validation.valid
									? ({
											success: false,
											error: new Error(
												`Invalid input for ${name}: ${validation.errors.map((error) => `${error.instanceLocation}: ${error.error}`).join('; ')}. Expected ${JSON.stringify(declaredSchema)}`,
											),
										} satisfies { success: false; error: Error })
									: schema.validate
										? await schema.validate(normalized)
										: ({ success: true, value: normalized } satisfies { success: true; value: unknown });
							if (!result.success && context.activeCodeMode)
								context.failureGuard?.record({ id: crypto.randomUUID(), toolName: name, input, error: String(result.error) });
							return result;
						},
					}),
				}
			: {}),
		execute: async (input: unknown, options?: { toolCallId?: string; abortSignal?: AbortSignal }) => {
			context.failureGuard?.assertHealthy();
			const id = options?.toolCallId ?? crypto.randomUUID();
			const signals = [
				context.abortSignal,
				options?.abortSignal,
				context.activeCodeMode?.abortSignal,
				context.failureGuard?.controller.signal,
			].filter((signal) => signal !== undefined);
			const abortSignal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
			abortSignal?.throwIfAborted();
			if (MUTATION_TOOL_NAMES.has(name) || name === 'browser') await context.beforeMutation?.();
			try {
				const output: unknown = await Reflect.apply(execute, definition, [
					input,
					{
						...options,
						harnessOutcomeId: id,
						toolCallId: options?.toolCallId ?? context.activeCodeMode?.toolCallId ?? id,
						abortSignal,
					},
				]);
				context.failureGuard?.record({ id, toolName: name, input, error: toolOutputError(output) });
				return output;
			} catch (error) {
				context.failureGuard?.record({ id, toolName: name, input, error: String(error) });
				throw error;
			}
		},
	};
}

/** The SDK and validator expose compatible JSON schemas with different keyword typings. */
function validateDeclaredInput(schema: object, input: unknown) {
	return new Validator(schema, '7', false).validate(input);
}
