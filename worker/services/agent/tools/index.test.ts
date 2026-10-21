import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { toolInputSchemas } from '@shared/validation';

import {
	AGENT_TOOLS,
	ASK_MODE_TOOLS,
	MUTATION_TOOL_NAMES,
	PLAN_MODE_TOOLS,
	READ_ONLY_TOOL_NAMES,
	SUB_AGENT_EXCLUDED_TOOLS,
	TOOL_EXECUTORS,
} from './index';

describe('PLAN_MODE_TOOLS', () => {
	it('only includes read-only and research tools', () => {
		const toolNames = PLAN_MODE_TOOLS.map((tool) => tool.name);
		expect(toolNames).toContain('docs_search');
		expect(toolNames).toContain('web_fetch');
		expect(toolNames).toContain('user_question');
		expect(toolNames).toContain('todos_get');
		expect(toolNames).toContain('todos_update');
	});

	it('excludes mutating tools (file ops are state.* in Code Mode)', () => {
		const toolNames = PLAN_MODE_TOOLS.map((tool) => tool.name);
		expect(toolNames).not.toContain('lint_fix');
		expect(toolNames).not.toContain('dependencies_update');
		expect(toolNames).not.toContain('image_generate');
		expect(toolNames).not.toContain('bash');
	});

	it('is a subset of AGENT_TOOLS', () => {
		const agentToolNames = new Set(AGENT_TOOLS.map((tool) => tool.name));
		for (const tool of PLAN_MODE_TOOLS) {
			expect(agentToolNames.has(tool.name)).toBe(true);
		}
	});
});

describe('ASK_MODE_TOOLS', () => {
	it('includes read-only tools', () => {
		const toolNames = ASK_MODE_TOOLS.map((tool) => tool.name);
		expect(toolNames).toContain('docs_search');
		expect(toolNames).toContain('web_fetch');
		expect(toolNames).toContain('user_question');
		expect(toolNames).toContain('dependencies_list');
		expect(toolNames).toContain('lint_check');
		expect(toolNames).toContain('test_run');
	});

	it('excludes TODO and plan tools', () => {
		const toolNames = ASK_MODE_TOOLS.map((tool) => tool.name);
		expect(toolNames).not.toContain('todos_get');
		expect(toolNames).not.toContain('todos_update');
		expect(toolNames).not.toContain('plan_update');
	});

	it('excludes mutating tools', () => {
		const toolNames = ASK_MODE_TOOLS.map((tool) => tool.name);
		expect(toolNames).not.toContain('lint_fix');
		expect(toolNames).not.toContain('dependencies_update');
		expect(toolNames).not.toContain('bash');
	});

	it('is a subset of AGENT_TOOLS', () => {
		const agentToolNames = new Set(AGENT_TOOLS.map((tool) => tool.name));
		for (const tool of ASK_MODE_TOOLS) {
			expect(agentToolNames.has(tool.name)).toBe(true);
		}
	});
});

describe('AGENT_TOOLS', () => {
	it('every tool has name, description, and input_schema', () => {
		for (const tool of AGENT_TOOLS) {
			expect(tool.name).toBeTruthy();
			expect(tool.description).toBeTruthy();
			expect(tool.input_schema).toBeDefined();
			expect(tool.input_schema.type).toBe('object');
		}
	});

	it('has no duplicate tool names', () => {
		const names = AGENT_TOOLS.map((tool) => tool.name);
		expect(new Set(names).size).toBe(names.length);
	});
});

describe('MUTATION_TOOL_NAMES', () => {
	it('has no overlap with READ_ONLY_TOOL_NAMES', () => {
		for (const name of MUTATION_TOOL_NAMES) {
			expect(READ_ONLY_TOOL_NAMES.has(name)).toBe(false);
		}
	});
});

describe('SUB_AGENT_EXCLUDED_TOOLS', () => {
	it('prevents recursive delegation and durable parent-session interactions', () => {
		expect(SUB_AGENT_EXCLUDED_TOOLS).toEqual(new Set(['sub_agent', 'user_question', 'plan_update', 'todos_get', 'todos_update']));
	});
});

describe('tool registration sync', () => {
	it('keeps declared argument names aligned with shared validation', () => {
		const schemas = new Map(Object.entries(toolInputSchemas));
		for (const definition of AGENT_TOOLS) {
			const schema = schemas.get(definition.name);
			if (!schema) throw new Error(`Missing schema for ${definition.name}`);
			const sharedSchema = z.toJSONSchema(schema);
			expect(Object.keys(definition.input_schema.properties ?? {}).toSorted(), definition.name).toEqual(
				Object.keys(sharedSchema.properties ?? {}).toSorted(),
			);
			expect([...(definition.input_schema.required ?? [])].toSorted(), definition.name).toEqual(
				[...(sharedSchema.required ?? [])].toSorted(),
			);
		}
	});

	const externalToolNames = [
		'read',
		'ls',
		'list',
		'find',
		'grep',
		'write',
		'edit',
		'delete',
		'exec',
		'browser_execute',
		'browser_markdown',
		'browser_extract',
		'browser_links',
		'browser_scrape',
		'cdp_eval',
		'codemode',
		'list_extensions',
		'load_extension',
	];
	const executorNames = [...TOOL_EXECUTORS.keys()].toSorted();
	const definitionNames = AGENT_TOOLS.map((tool) => tool.name).toSorted();
	const schemaNames = Object.keys(toolInputSchemas)
		.filter((name) => !externalToolNames.includes(name))
		.toSorted();

	it('TOOL_EXECUTORS matches AGENT_TOOLS definitions', () => {
		expect(executorNames).toEqual(definitionNames);
	});

	it('AGENT_TOOLS definitions match shared validation schemas', () => {
		expect(definitionNames).toEqual(schemaNames);
	});

	it('TOOL_EXECUTORS matches shared validation schemas', () => {
		expect(executorNames).toEqual(schemaNames);
	});

	it('shared validation includes external and legacy-only tools', () => {
		for (const name of externalToolNames) {
			expect(toolInputSchemas).toHaveProperty(name);
		}
	});
});
