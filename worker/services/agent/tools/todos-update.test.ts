import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryFs, createMockContext, createMockSendEvent } from './test-helpers';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const memoryFs = createMemoryFs();

vi.mock('@worker/lib/project-fs', () => memoryFs.asMock());

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

const { execute } = await import('./todos-update');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = '/project';

function context() {
	return createMockContext({ projectRoot: PROJECT_ROOT, sessionId: 'ses-update' });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('todos_update', () => {
	beforeEach(() => {
		memoryFs.reset();
	});

	// ── Successful creation ───────────────────────────────────────────────

	it('creates todos and returns success with count', async () => {
		const todos = [
			{ id: '1', content: 'Task A', status: 'pending', priority: 'high' },
			{ id: '2', content: 'Task B', status: 'in_progress', priority: 'medium' },
		];

		// Cast as Record<string, string> since the tool receives input that way
		const result = await execute({ todos } as unknown as Record<string, string>, createMockSendEvent(), context());

		expect(result).toHaveProperty('output');
		expect(result.metadata).toHaveProperty('todos');
		const todosResult = result.metadata.todos as unknown[];
		expect(todosResult).toHaveLength(2);
		expect(JSON.parse(result.output)).toEqual({ todos });
		// File should be written
		expect(memoryFs.store.has(`${PROJECT_ROOT}/.agent/todo/ses-update.json`)).toBe(true);
	});

	it('persists todos to the filesystem as JSON', async () => {
		const todos = [{ id: 't1', content: 'Persist me', status: 'pending', priority: 'low' }];

		await execute({ todos } as unknown as Record<string, string>, createMockSendEvent(), context());

		const entry = memoryFs.store.get(`${PROJECT_ROOT}/.agent/todo/ses-update.json`);
		expect(entry).toBeDefined();
		const parsed = JSON.parse(entry!.content as string);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].content).toBe('Persist me');
	});

	// ── String JSON input ─────────────────────────────────────────────────

	it('parses string JSON for the todos field', async () => {
		const todosJson = JSON.stringify([{ id: '1', content: 'From JSON', status: 'completed', priority: 'high' }]);

		const result = await execute({ todos: todosJson } as unknown as Record<string, string>, createMockSendEvent(), context());

		expect(result).toHaveProperty('output');
		const todosResult = result.metadata.todos as unknown[];
		expect(todosResult).toHaveLength(1);
	});

	// ── Validation errors ─────────────────────────────────────────────────

	it('rejects invalid todo items', async () => {
		const invalidTodos = [{ id: '', content: '', status: 'bad_status', priority: 'bad_priority' }];

		await expect(execute({ todos: invalidTodos } as unknown as Record<string, string>, createMockSendEvent(), context())).rejects.toThrow(
			'Invalid TODO item',
		);
	});

	it('rejects non-array input', async () => {
		await expect(
			execute({ todos: { not: 'an array' } } as unknown as Record<string, string>, createMockSendEvent(), context()),
		).rejects.toThrow('must be an array');
	});

	it('rejects invalid JSON string', async () => {
		await expect(
			execute({ todos: 'not valid json{{{' } as unknown as Record<string, string>, createMockSendEvent(), context()),
		).rejects.toThrow('Invalid JSON');
	});

	// ── All valid statuses and priorities ──────────────────────────────────

	it('accepts all valid status and priority values', async () => {
		const todos = [
			{ id: '1', content: 'Pending high', status: 'pending', priority: 'high' },
			{ id: '2', content: 'In progress medium', status: 'in_progress', priority: 'medium' },
			{ id: '3', content: 'Completed low', status: 'completed', priority: 'low' },
		];

		const result = await execute({ todos } as unknown as Record<string, string>, createMockSendEvent(), context());

		expect(result).toHaveProperty('output');
		const todosResult = result.metadata.todos as unknown[];
		expect(todosResult).toHaveLength(3);
	});

	it('indexes todos into searchable artifacts when available', async () => {
		const indexArtifact = vi.fn(async () => {});
		const todos = [{ id: '1', content: 'Track me', status: 'pending', priority: 'high' }];

		await execute(
			{ todos } as unknown as Record<string, string>,
			createMockSendEvent(),
			createMockContext({ projectRoot: PROJECT_ROOT, sessionId: 'ses-update', indexArtifact }),
		);

		expect(indexArtifact).toHaveBeenCalledOnce();
		expect(indexArtifact.mock.calls[0]?.[0]).toMatchObject({ key: 'todos:ses-update' });
	});
});
