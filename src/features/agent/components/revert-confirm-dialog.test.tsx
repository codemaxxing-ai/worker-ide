import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RevertConfirmDialog } from './revert-confirm-dialog';

import type { ReactNode } from 'react';

function renderWithQueryClient(children: ReactNode) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>);
}

describe('RevertConfirmDialog', () => {
	it('describes an empty file restoration', () => {
		const onConfirm = vi.fn();
		renderWithQueryClient(
			<RevertConfirmDialog
				open
				onOpenChange={() => {}}
				snapshotIds={[]}
				messageIndex={2}
				projectId="project-1"
				onConfirm={onConfirm}
				isReverting={false}
			/>,
		);

		expect(screen.getByText('No file changes to restore.')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
		expect(onConfirm).toHaveBeenCalledWith([], 2);
	});
});
