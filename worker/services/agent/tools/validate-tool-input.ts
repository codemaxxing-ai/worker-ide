/**
 * Tool input validation + coercion shared by every wrapped tool.
 *
 * Tool inputs reach us from two places: the model's top-level tool calls (where
 * the AI SDK can retry via `experimental_repairToolCall`) and — far more often
 * in Code Mode — `tools.*` calls the model writes inside the codemode sandbox.
 * The sandbox path has NO repair step: whatever Error we throw here is the only
 * feedback the model gets before its next turn. So the messages below are
 * deliberately verbose: they restate the exact expected shape (in the same
 * TypeScript notation the model already sees in the generated `tools.*` types)
 * and call out the keys the model actually sent, so it can self-correct.
 */

import { Validator } from '@cfworker/json-schema';

import type { ToolJsonSchema as Schema, ToolDefinition } from '../types';

type ToolInputSchema = ToolDefinition['input_schema'];

export type ValidateToolInputResult = { success: true; value: Record<string, string> } | { success: false; error: Error };

interface PropertySchema {
	type?: string | string[];
	enum?: unknown[];
	items?: unknown;
}

function asPropertySchema(value: unknown): PropertySchema {
	if (typeof value !== 'object' || value === null) {
		return {};
	}
	const result: PropertySchema = {};
	if ('type' in value && (typeof value.type === 'string' || Array.isArray(value.type))) {
		result.type = value.type;
	}
	if ('enum' in value && Array.isArray(value.enum)) {
		result.enum = value.enum;
	}
	if ('items' in value) {
		result.items = value.items;
	}
	return result;
}

/** Render a single property's JSON Schema as a TypeScript-ish type string. */
function renderType(value: unknown): string {
	const schema = asPropertySchema(value);
	if (schema.enum && schema.enum.length > 0) {
		return schema.enum.map((entry) => JSON.stringify(entry)).join(' | ');
	}
	const { type } = schema;
	if (type === 'array') {
		return `${renderType(schema.items)}[]`;
	}
	if (Array.isArray(type)) {
		return type.join(' | ');
	}
	if (typeof type === 'string') {
		return type;
	}
	return 'unknown';
}

/**
 * Produce a compact TypeScript-style description of the schema, e.g.
 * `{ action: "add" | "remove" | "update"; name: string; version?: string }`.
 * Returns `{}` when the schema declares no properties.
 */
export function describeInputSchema(schema: ToolInputSchema): string {
	const properties = schema.properties ?? {};
	const requiredProperties = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
	const entries = Object.entries(properties);
	if (entries.length === 0) {
		return '{}';
	}
	const parts = entries.map(([name, propertySchema]) => {
		const optionalMarker = requiredProperties.has(name) ? '' : '?';
		return `${name}${optionalMarker}: ${renderType(propertySchema)}`;
	});
	return `{ ${parts.join('; ')} }`;
}

/**
 * Coerce loose model-supplied input into an object.
 * - `undefined`/`null` → `{}` (callers that forgot the argument, or empty-schema
 *   tools the model invoked as `tool()` instead of `tool({})`).
 * - A JSON string that parses to an object → the parsed object (some models
 *   stringify their arguments).
 * Anything else is returned unchanged so the validator can report it.
 */
export function coerceToObject(value: unknown): unknown {
	if (value === undefined || value === null) {
		return {};
	}
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
			try {
				const parsed: unknown = JSON.parse(trimmed);
				if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
					return parsed;
				}
			} catch {
				// Fall through and let the validator report the bad shape.
			}
		}
	}
	return value;
}

/**
 * Validate and coerce a tool's input against its declared JSON Schema.
 *
 * On success the returned object contains only known properties, with object /
 * array values JSON-serialized to strings (structured data survives the trip to
 * an executor that expects `Record<string, string>`). On failure the Error
 * message restates the expected shape so the model can self-correct.
 */
export function validateAndCoerceToolInput(toolName: string, schema: ToolInputSchema, rawValue?: unknown): ValidateToolInputResult {
	const expectedShape = describeInputSchema(schema);
	const value = coerceToObject(rawValue);

	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return {
			success: false,
			error: new Error(
				`Tool "${toolName}" expects a single object argument matching ${expectedShape}. ` +
					`Received ${Array.isArray(value) ? 'an array' : typeof value}. ` +
					`The exact input type is declared on the \`tools.${toolName}\` signature in the codemode type definitions.`,
			),
		};
	}

	const requiredProperties = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
	const knownProperties = new Set<string>(schema.properties ? Object.keys(schema.properties) : []);
	const entries = Object.entries(value);
	const keys = entries.map(([key]) => key);

	const missing = [...requiredProperties].filter((required) => !(required in value) || Reflect.get(value, required) === undefined);
	if (missing.length > 0) {
		const unknownKeys = keys.filter((key) => !knownProperties.has(key));
		const unknownHint =
			unknownKeys.length > 0
				? ` Unrecognized key(s): ${unknownKeys.map((key) => `"${key}"`).join(', ')} (not part of this tool's input).`
				: '';
		const quotedMissing = missing.map((name) => `"${name}"`).join(', ');
		return {
			success: false,
			error: new Error(
				`Tool "${toolName}" is missing required propert${missing.length === 1 ? 'y' : 'ies'}: ${quotedMissing}. ` +
					`Received keys: ${keys.length > 0 ? keys.join(', ') : '(none)'}.${unknownHint} ` +
					`Expected shape: ${expectedShape}. ` +
					`Inspect the \`tools.${toolName}\` signature in the codemode type definitions for the exact input.`,
			),
		};
	}

	const validation = new Validator(closeToolInputSchema(schema), '7', false).validate(value);
	if (!validation.valid) {
		return {
			success: false,
			error: new Error(
				`Tool "${toolName}" has invalid input: ${validation.errors.map((error) => `${error.instanceLocation}: ${error.error}`).join('; ')}. Expected shape: ${expectedShape}. Inspect the \`tools.${toolName}\` signature.`,
			),
		};
	}
	const validated: Record<string, string> = {};
	for (const [key, entryValue] of entries) {
		if (entryValue === undefined) continue;
		validated[key] = typeof entryValue === 'object' && entryValue !== null ? JSON.stringify(entryValue) : String(entryValue);
	}
	return { success: true, value: validated };
}

/** Close declared object shapes while leaving explicit dictionary schemas open. */
export function closeToolInputSchema(schema: Schema): Schema {
	return {
		...schema,
		...(schema.properties
			? {
					additionalProperties: schema.additionalProperties ?? false,
					properties: Object.fromEntries(
						Object.entries(schema.properties).map(([key, property]) => [
							key,
							typeof property === 'boolean' ? property : closeToolInputSchema(property),
						]),
					),
				}
			: {}),
		...(schema.items && typeof schema.items !== 'boolean' ? { items: closeToolInputSchema(schema.items) } : {}),
		...(schema.additionalProperties && typeof schema.additionalProperties !== 'boolean'
			? { additionalProperties: closeToolInputSchema(schema.additionalProperties) }
			: {}),
	};
}
