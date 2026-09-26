import { describe, expect, it, vi } from 'vitest';

import { transferProjectTree } from './project-tree-transfer';

function createTree() {
	const dispose = vi.fn();
	const tree = Object.assign([{ path: '/README.md', content: new TextEncoder().encode('hello') }], {
		[Symbol.dispose]: dispose,
	});
	return { tree, dispose };
}

describe('project tree transfer', () => {
	it('disposes the source RPC result after a successful import', async () => {
		const { tree, dispose } = createTree();
		const importTree = vi.fn(async () => {
			expect(dispose).not.toHaveBeenCalled();
		});

		await transferProjectTree({ exportTree: async () => tree }, { importTree });

		expect(importTree).toHaveBeenCalledWith(tree);
		expect(dispose).toHaveBeenCalledOnce();
	});

	it('disposes the source RPC result when the import fails', async () => {
		const { tree, dispose } = createTree();
		const failure = new Error('Import failed');

		await expect(
			transferProjectTree(
				{ exportTree: async () => tree },
				{
					importTree: async () => {
						throw failure;
					},
				},
			),
		).rejects.toBe(failure);
		expect(dispose).toHaveBeenCalledOnce();
	});
});
