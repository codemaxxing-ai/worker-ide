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

const { execute } = await import('./todos-get');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = '/project';

function context() {
	return createMockContext({ projectRoot: PROJECT_ROOT, sessionId: 'ses-todo' });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('todos_get', () => {
	beforeEach(() => {
		memoryFs.reset();
	});

	// ── Reading existing todos ────────────────────────────────────────────

	it('reads and returns validated todo items', async () => {
		const todos = [
			{ id: '1', content: 'Fix bug', status: 'pending', priority: 'high' },
			{ id: '2', content: 'Add tests', status: 'in_progress', priority: 'medium' },
			{ id: '3', content: 'Deploy', status: 'completed', priority: 'low' },
		];
		memoryFs.seedFile(`${PROJECT_ROOT}/.agent/todo/ses-todo.json`, JSON.stringify(todos));

		const result = await execute({}, createMockSendEvent(), context());

		expect(result.metadata).toHaveProperty('todos');
		const todosResult = result.metadata.todos as unknown[];
		expect(todosResult).toHaveLength(3);
		expect(todosResult[0]).toHaveProperty('id', '1');
		expect(todosResult[0]).toHaveProperty('status', 'pending');
		expect(JSON.parse(result.output)).toEqual({ todos });
	});

	// ── No todos file ─────────────────────────────────────────────────────

	it('returns empty array when no todo file exists', async () => {
		const result = await execute({}, createMockSendEvent(), context());

		expect(result.metadata).toHaveProperty('todos');
		const todosResult = result.metadata.todos as unknown[];
		expect(todosResult).toHaveLength(0);
	});

	// ── Invalid items filtered ────────────────────────────────────────────

	it('filters out invalid todo items during validation', async () => {
		const mixed = [
			{ id: '1', content: 'Valid', status: 'pending', priority: 'high' },
			{ id: '', content: '', status: 'invalid', priority: 'wrong' }, // Invalid
			{ id: '3', content: 'Also valid', status: 'completed', priority: 'low' },
		];
		memoryFs.seedFile(`${PROJECT_ROOT}/.agent/todo/ses-todo.json`, JSON.stringify(mixed));

		const result = await execute({}, createMockSendEvent(), context());

		const todosResult = result.metadata.todos as unknown[];
		expect(todosResult).toHaveLength(2);
	});

	// ── Corrupted JSON ────────────────────────────────────────────────────

	it('returns empty array for corrupted JSON', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/.agent/todo/ses-todo.json`, 'not valid json{{{');

		const result = await execute({}, createMockSendEvent(), context());

		const todosResult = result.metadata.todos as unknown[];
		expect(todosResult).toHaveLength(0);
	});

	// ── Non-array JSON ────────────────────────────────────────────────────

	it('returns empty array for non-array JSON', async () => {
		memoryFs.seedFile(`${PROJECT_ROOT}/.agent/todo/ses-todo.json`, JSON.stringify({ not: 'an array' }));

		const result = await execute({}, createMockSendEvent(), context());

		const todosResult = result.metadata.todos as unknown[];
		expect(todosResult).toHaveLength(0);
	});
});
