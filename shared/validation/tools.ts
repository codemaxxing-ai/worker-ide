import { z } from 'zod';

import { AI_MODEL_IDS_TUPLE } from '../constants';
import { filePathSchema } from './file-system';

export const aiModelSchema = z.enum(AI_MODEL_IDS_TUPLE);
export type AllowedAIModel = z.infer<typeof aiModelSchema>;
export const searchCloudflareDocumentationInputSchema = z.object({
	query: z.string().min(1, 'Query is required'),
});
export const todoItemSchema = z.object({
	id: z.string().min(1),
	content: z.string().min(1),
	status: z.enum(['pending', 'in_progress', 'completed']),
	priority: z.enum(['high', 'medium', 'low']),
});
export const updatePlanInputSchema = z.object({
	content: z.string().min(1, 'Plan content is required'),
});
export const getTodosInputSchema = z.object({});
export const updateTodosInputSchema = z.object({
	todos: z.array(todoItemSchema),
});
export const questionInputSchema = z.object({
	question: z.string().min(1, 'Question is required'),
	options: z.string().optional(),
});
export const webfetchInputSchema = z.object({
	url: z.string().url('Must be a valid URL'),
	prompt: z.string().min(1, 'Prompt is required'),
});
export const dependenciesListInputSchema = z.object({});
export const dependenciesUpdateInputSchema = z.object({
	action: z.enum(['add', 'remove', 'update']),
	name: z.string().min(1, 'Package name is required'),
	version: z.string().optional(),
});
export const assetSettingsGetInputSchema = z.object({});
export const bindingsGetInputSchema = z.object({});
export const bindingsUpdateInputSchema = z.object({
	storage: z.string().optional(),
});
export const assetSettingsUpdateInputSchema = z.object({
	not_found_handling: z.string().optional(),
	html_handling: z.string().optional(),
	run_worker_first: z.string().optional(),
});
export const lintCheckInputSchema = z.object({
	path: filePathSchema,
});
export const lintFixInputSchema = z.object({
	path: filePathSchema,
});

export const cdpEvalInputSchema = z.object({
	method: z.string().min(1, 'CDP method is required'),
	params: z.string().optional(),
});
export const previewFetchInputSchema = z.object({
	path: z.string().min(1, 'Path is required'),
	method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
	headers: z.string().optional(),
	body: z.string().optional(),
	format: z.enum(['raw', 'markdown']).optional(),
});
export const testRunInputSchema = z.object({
	pattern: z.string().optional(),
	testName: z.string().optional(),
});
export const imageGenerateInputSchema = z.object({
	prompt: z.string().min(1, 'Prompt is required'),
	path: filePathSchema,
});
export const subAgentInputSchema = z.object({
	prompt: z.string().min(1, 'Prompt is required'),
	context: z.string().optional(),
});

export const codemodeInputSchema = z.object({
	code: z.string().min(1, 'Code is required'),
});

export const browserExecuteInputSchema = z.object({
	code: z.string().min(1, 'Code is required'),
});

// Browser Run Quick Action tools. Each operates on a page identified by a
// `url` (or raw `html`), mirroring the input shapes of the Agents SDK
// `createBrowserTools` Quick Action tools.
export const browserMarkdownInputSchema = z.object({
	url: z.string().optional(),
	html: z.string().optional(),
});

export const browserLinksInputSchema = z.object({
	url: z.string().optional(),
	html: z.string().optional(),
});

export const browserExtractInputSchema = z.object({
	url: z.string().optional(),
	html: z.string().optional(),
	prompt: z.string().optional(),
	schema: z.unknown().optional(),
});

export const browserScrapeInputSchema = z.object({
	url: z.string().optional(),
	html: z.string().optional(),
	selectors: z.array(z.string()).min(1, 'At least one selector is required'),
});

export const loadExtensionInputSchema = z.object({
	name: z.string().min(1, 'Name is required'),
	version: z.string().min(1, 'Version is required'),
	source: z.string().min(1, 'Source is required'),
	description: z.string().optional(),
	workspace_access: z.enum(['none', 'read', 'read-write']).optional(),
	network: z.array(z.string()).optional(),
});

export const listExtensionsInputSchema = z.object({});

export const bashInputSchema = z.object({
	command: z.string().min(1, 'Command is required'),
});

export const toolInputSchemas = {
	user_question: questionInputSchema,
	web_fetch: webfetchInputSchema,
	docs_search: searchCloudflareDocumentationInputSchema,
	plan_update: updatePlanInputSchema,
	todos_get: getTodosInputSchema,
	todos_update: updateTodosInputSchema,
	dependencies_list: dependenciesListInputSchema,
	dependencies_update: dependenciesUpdateInputSchema,
	asset_settings_get: assetSettingsGetInputSchema,
	asset_settings_update: assetSettingsUpdateInputSchema,
	bindings_get: bindingsGetInputSchema,
	bindings_update: bindingsUpdateInputSchema,
	lint_check: lintCheckInputSchema,
	lint_fix: lintFixInputSchema,
	cdp_eval: cdpEvalInputSchema,
	preview_fetch: previewFetchInputSchema,
	test_run: testRunInputSchema,
	image_generate: imageGenerateInputSchema,
	sub_agent: subAgentInputSchema,
	bash: bashInputSchema,
	codemode: codemodeInputSchema,
	browser_execute: browserExecuteInputSchema,
	browser_markdown: browserMarkdownInputSchema,
	browser_extract: browserExtractInputSchema,
	browser_links: browserLinksInputSchema,
	browser_scrape: browserScrapeInputSchema,
	load_extension: loadExtensionInputSchema,
	list_extensions: listExtensionsInputSchema,
} as const;

export type ToolName = keyof typeof toolInputSchemas;
export function validateToolInput(
	toolName: ToolName,
	input: unknown,
): { success: true; data: unknown } | { success: false; error: string } {
	const schema = toolInputSchemas[toolName];
	if (!schema) {
		return { success: false, error: `Unknown tool: ${toolName}` };
	}

	const result = schema.safeParse(input);
	if (!result.success) {
		const formatted = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ');
		return { success: false, error: `Invalid input for ${toolName}: ${formatted}` };
	}

	return { success: true, data: result.data };
}
