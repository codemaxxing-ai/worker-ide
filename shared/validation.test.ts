import { describe, expect, it } from 'vitest';

import {
	deployAccountIdSchema,
	deployRequestSchema,
	deployWorkerNameSchema,
	filePathSchema,
	writeFileSchema,
	sessionIdSchema,
	snapshotIdSchema,
	revertCascadeSchema,
	todoItemSchema,
	isPathSafe,
	validateToolInput,
	validateDependencyName,
	validateDependencyVersion,
	LIMITS,
} from './validation';

describe('deploy validation schemas', () => {
	it('accepts a valid deploy account ID', () => {
		expect(deployAccountIdSchema.safeParse('d64471fef208e0cf9687449dc8a5878b').success).toBe(true);
	});

	it('rejects a non-hex deploy account ID', () => {
		expect(deployAccountIdSchema.safeParse('not-an-account-id').success).toBe(false);
	});

	it('accepts a worker name that sanitizes to a valid value', () => {
		expect(deployWorkerNameSchema.safeParse('My New Worker').success).toBe(true);
	});

	it('rejects a worker name longer than 24 characters', () => {
		expect(deployWorkerNameSchema.safeParse('a'.repeat(25)).success).toBe(false);
	});

	it('rejects a worker name with no letters or numbers', () => {
		expect(deployWorkerNameSchema.safeParse('---').success).toBe(false);
	});

	it('rejects worker names with control characters', () => {
		expect(deployWorkerNameSchema.safeParse(`worker${String.fromCodePoint(10)}name`).success).toBe(false);
	});

	it('accepts a temporary deployment without an account ID', () => {
		expect(deployRequestSchema.safeParse({ mode: 'temporary', workerName: 'my-worker' }).success).toBe(true);
	});

	it('requires an account ID for permanent deployments', () => {
		expect(deployRequestSchema.safeParse({ mode: 'permanent', workerName: 'my-worker' }).success).toBe(false);
	});
});

describe('filePathSchema', () => {
	it('accepts valid paths', () => {
		expect(filePathSchema.safeParse('/src/main.ts').success).toBe(true);
		expect(filePathSchema.safeParse('/file.ts').success).toBe(true);
		expect(filePathSchema.safeParse('/a/b/c/d.tsx').success).toBe(true);
	});

	it('rejects empty paths', () => {
		expect(filePathSchema.safeParse('').success).toBe(false);
	});

	it('rejects paths without leading slash', () => {
		expect(filePathSchema.safeParse('src/main.ts').success).toBe(false);
	});

	it('rejects paths with ..', () => {
		expect(filePathSchema.safeParse('/src/../etc/passwd').success).toBe(false);
	});

	it('rejects paths with consecutive slashes', () => {
		expect(filePathSchema.safeParse('/src//main.ts').success).toBe(false);
	});

	it('rejects paths exceeding max length', () => {
		const longPath = '/' + 'a'.repeat(LIMITS.PATH_MAX_LENGTH);
		expect(filePathSchema.safeParse(longPath).success).toBe(false);
	});
});

describe('writeFileSchema', () => {
	it('accepts valid write input', () => {
		const result = writeFileSchema.safeParse({
			path: '/src/main.ts',
			content: 'console.log("hello");',
		});
		expect(result.success).toBe(true);
	});

	it('rejects missing path', () => {
		const result = writeFileSchema.safeParse({
			content: 'hello',
		});
		expect(result.success).toBe(false);
	});

	it('rejects missing content', () => {
		const result = writeFileSchema.safeParse({
			path: '/src/main.ts',
		});
		expect(result.success).toBe(false);
	});
});

describe('sessionIdSchema', () => {
	it('accepts valid session IDs', () => {
		expect(sessionIdSchema.safeParse('11111111-1111-4111-8111-111111111111').success).toBe(true);
	});

	it('rejects uppercase characters', () => {
		expect(sessionIdSchema.safeParse('ABC123').success).toBe(false);
	});

	it('rejects special characters', () => {
		expect(sessionIdSchema.safeParse('abc-123').success).toBe(false);
	});

	it('rejects empty string', () => {
		expect(sessionIdSchema.safeParse('').success).toBe(false);
	});
});

describe('snapshotIdSchema', () => {
	it('accepts valid hex IDs', () => {
		expect(snapshotIdSchema.safeParse('abcdef0123456789').success).toBe(true);
	});

	it('rejects non-hex characters', () => {
		expect(snapshotIdSchema.safeParse('xyz123').success).toBe(false);
	});

	it('rejects empty string', () => {
		expect(snapshotIdSchema.safeParse('').success).toBe(false);
	});
});

describe('revertCascadeSchema', () => {
	it('accepts a single snapshot ID', () => {
		expect(revertCascadeSchema.safeParse({ operationId: crypto.randomUUID(), snapshotIds: ['abcdef01'] }).success).toBe(true);
	});

	it('accepts multiple snapshot IDs', () => {
		expect(revertCascadeSchema.safeParse({ operationId: crypto.randomUUID(), snapshotIds: ['abcdef01', '12345678'] }).success).toBe(true);
	});

	it('rejects empty array', () => {
		expect(revertCascadeSchema.safeParse({ operationId: crypto.randomUUID(), snapshotIds: [] }).success).toBe(false);
	});

	it('rejects non-hex snapshot IDs', () => {
		expect(revertCascadeSchema.safeParse({ operationId: crypto.randomUUID(), snapshotIds: ['xyz!@#'] }).success).toBe(false);
	});

	it('rejects when snapshotIds is missing', () => {
		expect(revertCascadeSchema.safeParse({}).success).toBe(false);
	});

	it('rejects more than 20 snapshot IDs', () => {
		const tooMany = Array.from({ length: 21 }, (_, index) => index.toString(16).padStart(8, '0'));
		expect(revertCascadeSchema.safeParse({ operationId: crypto.randomUUID(), snapshotIds: tooMany }).success).toBe(false);
	});
});

describe('isPathSafe', () => {
	it('returns true for valid paths', () => {
		expect(isPathSafe('/src/main.ts')).toBe(true);
	});

	it('returns false for path traversal', () => {
		expect(isPathSafe('/src/../etc/passwd')).toBe(false);
	});

	it('returns false for paths without leading slash', () => {
		expect(isPathSafe('src/main.ts')).toBe(false);
	});
});

describe('validateToolInput', () => {
	it('validates exec input', () => {
		const result = validateToolInput('exec', { command: 'ls -la' });
		expect(result.success).toBe(true);
	});

	it('rejects invalid exec input', () => {
		const result = validateToolInput('exec', { command: '' });
		expect(result.success).toBe(false);
	});

	it('validates docs_search input', () => {
		const result = validateToolInput('docs_search', { query: 'Workers KV' });
		expect(result.success).toBe(true);
	});

	it('rejects docs_search with empty query', () => {
		const result = validateToolInput('docs_search', { query: '' });
		expect(result.success).toBe(false);
	});

	it('validates todos_get input (empty object)', () => {
		const result = validateToolInput('todos_get', {});
		expect(result.success).toBe(true);
	});

	it('validates todos_update input', () => {
		const result = validateToolInput('todos_update', {
			todos: [
				{ id: '1', content: 'Fix bug', status: 'pending', priority: 'high' },
				{ id: '2', content: 'Add tests', status: 'in_progress', priority: 'medium' },
			],
		});
		expect(result.success).toBe(true);
	});

	it('rejects todos_update with invalid status', () => {
		const result = validateToolInput('todos_update', {
			todos: [{ id: '1', content: 'Fix bug', status: 'unknown', priority: 'high' }],
		});
		expect(result.success).toBe(false);
	});

	it('rejects todos_update with invalid priority', () => {
		const result = validateToolInput('todos_update', {
			todos: [{ id: '1', content: 'Fix bug', status: 'pending', priority: 'critical' }],
		});
		expect(result.success).toBe(false);
	});

	it('rejects todos_update with missing fields', () => {
		const result = validateToolInput('todos_update', {
			todos: [{ id: '1', content: 'Fix bug' }],
		});
		expect(result.success).toBe(false);
	});
});

describe('todoItemSchema', () => {
	it('accepts a valid TODO item', () => {
		const result = todoItemSchema.safeParse({
			id: 'task-1',
			content: 'Implement feature',
			status: 'pending',
			priority: 'high',
		});
		expect(result.success).toBe(true);
	});

	it('accepts all valid statuses', () => {
		for (const status of ['pending', 'in_progress', 'completed']) {
			const result = todoItemSchema.safeParse({
				id: '1',
				content: 'Task',
				status,
				priority: 'low',
			});
			expect(result.success).toBe(true);
		}
	});

	it('accepts all valid priorities', () => {
		for (const priority of ['high', 'medium', 'low']) {
			const result = todoItemSchema.safeParse({
				id: '1',
				content: 'Task',
				status: 'pending',
				priority,
			});
			expect(result.success).toBe(true);
		}
	});

	it('rejects empty id', () => {
		const result = todoItemSchema.safeParse({
			id: '',
			content: 'Task',
			status: 'pending',
			priority: 'high',
		});
		expect(result.success).toBe(false);
	});

	it('rejects empty content', () => {
		const result = todoItemSchema.safeParse({
			id: '1',
			content: '',
			status: 'pending',
			priority: 'high',
		});
		expect(result.success).toBe(false);
	});
});

describe('validateDependencyName', () => {
	it('accepts valid unscoped package names', () => {
		expect(validateDependencyName('react')).toBeUndefined();
		expect(validateDependencyName('lodash')).toBeUndefined();
		expect(validateDependencyName('my-package')).toBeUndefined();
		expect(validateDependencyName('my_package')).toBeUndefined();
		expect(validateDependencyName('my.package')).toBeUndefined();
	});

	it('accepts valid scoped package names', () => {
		expect(validateDependencyName('@scope/package')).toBeUndefined();
		expect(validateDependencyName('@cloudflare/workers-types')).toBeUndefined();
		expect(validateDependencyName('@types/react')).toBeUndefined();
	});

	it('rejects empty names', () => {
		expect(validateDependencyName('')).toBeDefined();
		expect(validateDependencyName('  ')).toBeDefined();
	});

	it('rejects names with uppercase letters', () => {
		expect(validateDependencyName('React')).toBeDefined();
		expect(validateDependencyName('MyPackage')).toBeDefined();
	});

	it('rejects names with spaces', () => {
		expect(validateDependencyName('my package')).toBeDefined();
	});

	it('rejects names with special characters', () => {
		expect(validateDependencyName('my!package')).toBeDefined();
		expect(validateDependencyName('my@package')).toBeDefined();
	});

	it('rejects names exceeding 214 characters', () => {
		expect(validateDependencyName('a'.repeat(215))).toBeDefined();
	});
});

describe('validateDependencyVersion', () => {
	it('accepts wildcard version', () => {
		expect(validateDependencyVersion('*')).toBeUndefined();
	});

	it('accepts latest', () => {
		expect(validateDependencyVersion('latest')).toBeUndefined();
	});

	it('accepts exact versions', () => {
		expect(validateDependencyVersion('1.0.0')).toBeUndefined();
		expect(validateDependencyVersion('19.0.0')).toBeUndefined();
		expect(validateDependencyVersion('0.1.2')).toBeUndefined();
	});

	it('accepts caret ranges', () => {
		expect(validateDependencyVersion('^1.0.0')).toBeUndefined();
		expect(validateDependencyVersion('^0.1.0')).toBeUndefined();
	});

	it('accepts tilde ranges', () => {
		expect(validateDependencyVersion('~1.0.0')).toBeUndefined();
		expect(validateDependencyVersion('~0.1.0')).toBeUndefined();
	});

	it('accepts comparison ranges', () => {
		expect(validateDependencyVersion('>=1.0.0')).toBeUndefined();
		expect(validateDependencyVersion('>2.0.0')).toBeUndefined();
		expect(validateDependencyVersion('<=3.0.0')).toBeUndefined();
	});

	it('accepts x-ranges', () => {
		expect(validateDependencyVersion('1.x')).toBeUndefined();
		expect(validateDependencyVersion('1.2.x')).toBeUndefined();
	});

	it('accepts pre-release versions', () => {
		expect(validateDependencyVersion('1.0.0-beta.1')).toBeUndefined();
		expect(validateDependencyVersion('2.0.0-rc.0')).toBeUndefined();
	});

	it('rejects empty version', () => {
		expect(validateDependencyVersion('')).toBeDefined();
		expect(validateDependencyVersion('  ')).toBeDefined();
	});

	it('rejects invalid version strings', () => {
		expect(validateDependencyVersion('not a version')).toBeDefined();
		expect(validateDependencyVersion('abc')).toBeDefined();
		expect(validateDependencyVersion('v1.0.0')).toBeDefined();
	});
});
