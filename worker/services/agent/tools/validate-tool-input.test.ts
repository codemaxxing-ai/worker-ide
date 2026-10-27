import { describe, expect, it } from 'vitest';

import { describeInputSchema, validateAndCoerceToolInput } from './validate-tool-input';

import type { ToolDefinition } from '../types';

// Mirrors the real dependencies_update schema (single package per call).
const dependenciesUpdateSchema: ToolDefinition['input_schema'] = {
	type: 'object',
	properties: {
		action: { type: 'string', enum: ['add', 'remove', 'update'] },
		name: { type: 'string' },
		version: { type: 'string' },
	},
	required: ['action', 'name'],
};

const emptySchema: ToolDefinition['input_schema'] = { type: 'object', properties: {} };

const arraySchema: ToolDefinition['input_schema'] = {
	type: 'object',
	properties: {
		patterns: { type: 'array', items: { type: 'string' } },
	},
	required: ['patterns'],
};

describe('describeInputSchema', () => {
	it('renders required and optional properties with enum unions', () => {
		expect(describeInputSchema(dependenciesUpdateSchema)).toBe('{ action: "add" | "remove" | "update"; name: string; version?: string }');
	});

	it('renders an empty schema as {}', () => {
		expect(describeInputSchema(emptySchema)).toBe('{}');
	});

	it('renders array item types', () => {
		expect(describeInputSchema(arraySchema)).toBe('{ patterns: string[] }');
	});
});

describe('validateAndCoerceToolInput', () => {
	it('accepts a valid object and keeps known properties', () => {
		const result = validateAndCoerceToolInput('dependencies_update', dependenciesUpdateSchema, {
			action: 'add',
			name: 'react-confetti',
			version: '^6.4.0',
		});
		expect(result).toEqual({ success: true, value: { action: 'add', name: 'react-confetti', version: '^6.4.0' } });
	});

	it('coerces a missing argument to {} for empty schemas (tools.dependencies_list())', () => {
		const result = validateAndCoerceToolInput('dependencies_list', emptySchema);
		expect(result).toEqual({ success: true, value: {} });
	});

	it('coerces null to {} for empty schemas', () => {
		const result = validateAndCoerceToolInput('dependencies_list', emptySchema, JSON.parse('null'));
		expect(result).toEqual({ success: true, value: {} });
	});

	it('parses a JSON string argument into an object', () => {
		const result = validateAndCoerceToolInput('dependencies_update', dependenciesUpdateSchema, '{"action":"add","name":"zod"}');
		expect(result).toEqual({ success: true, value: { action: 'add', name: 'zod' } });
	});

	it('rejects unknown properties from a closed call', () => {
		const result = validateAndCoerceToolInput('dependencies_update', dependenciesUpdateSchema, {
			action: 'add',
			name: 'zod',
			extra: 'ignored',
		});
		expect(result.success).toBe(false);
	});

	it('JSON-serializes object/array values so structured data survives', () => {
		const result = validateAndCoerceToolInput('test_tool', arraySchema, { patterns: ['a', 'b'] });
		expect(result).toEqual({ success: true, value: { patterns: '["a","b"]' } });
	});

	it('reports the expected shape when a required property is missing', () => {
		const result = validateAndCoerceToolInput('dependencies_update', dependenciesUpdateSchema, { name: 'react' });
		expect(result.success).toBe(false);
		if (result.success) throw new Error('expected failure');
		expect(result.error.message).toContain('missing required property: "action"');
		expect(result.error.message).toContain('{ action: "add" | "remove" | "update"; name: string; version?: string }');
		expect(result.error.message).toContain('tools.dependencies_update');
	});

	it('flags unrecognized keys when required ones are missing (the packages[] mistake)', () => {
		const result = validateAndCoerceToolInput('dependencies_update', dependenciesUpdateSchema, {
			packages: [{ name: 'react-confetti', version: '^6.4.0' }],
		});
		expect(result.success).toBe(false);
		if (result.success) throw new Error('expected failure');
		expect(result.error.message).toContain('missing required properties: "action", "name"');
		expect(result.error.message).toContain('Unrecognized key(s): "packages"');
	});

	it('rejects an array argument with a shape hint', () => {
		const result = validateAndCoerceToolInput('dependencies_update', dependenciesUpdateSchema, [{ name: 'react' }]);
		expect(result.success).toBe(false);
		if (result.success) throw new Error('expected failure');
		expect(result.error.message).toContain('expects a single object argument');
		expect(result.error.message).toContain('Received an array');
	});

	it('rejects a non-object scalar argument', () => {
		const result = validateAndCoerceToolInput('dependencies_update', dependenciesUpdateSchema, 42);
		expect(result.success).toBe(false);
		if (result.success) throw new Error('expected failure');
		expect(result.error.message).toContain('Received number');
	});
});

describe('strict declared input shapes', () => {
	it.each([
		{ action: 'invented', name: 'zod' },
		{ action: 'add', name: 123 },
		{ action: 'add', name: undefined },
		// eslint-disable-next-line unicorn/no-null -- Exercise invalid JSON null input.
		{ action: 'add', name: null },
	])('rejects invalid values before string conversion: %j', (input) => {
		expect(validateAndCoerceToolInput('dependencies_update', dependenciesUpdateSchema, input).success).toBe(false);
	});
	it('validates nested array entries and rejects nested unknown properties', () => {
		const schema: ToolDefinition['input_schema'] = {
			type: 'object',
			properties: {
				entries: {
					type: 'array',
					items: { type: 'object', properties: { status: { type: 'string', enum: ['done'] } }, required: ['status'] },
				},
			},
			required: ['entries'],
		};
		for (const entry of [{ status: 'wrong' }, { status: 'done', extra: true }, {}])
			expect(validateAndCoerceToolInput('nested', schema, { entries: [entry] }).success).toBe(false);
		expect(validateAndCoerceToolInput('nested', schema, { entries: [{ status: 'done' }] })).toEqual({
			success: true,
			value: { entries: '[{"status":"done"}]' },
		});
	});
});
