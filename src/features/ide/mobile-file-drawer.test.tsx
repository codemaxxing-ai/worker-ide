import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GlobalDialogBackdrop } from '@/components/ui/global-dialog-backdrop';

import { MobileFileDrawer } from './mobile-file-drawer';

const mocks = vi.hoisted(() => {
	const toggleMobileFileTree = vi.fn();
	const storeState = {
		mobileFileTreeOpen: true,
		toggleMobileFileTree,
	};

	return {
		storeState,
		toggleMobileFileTree,
	};
});

function useMockStore(selector?: (state: typeof mocks.storeState) => unknown) {
	if (!selector) {
		return mocks.storeState;
	}

	return selector(mocks.storeState);
}

vi.mock('@/lib/store', () => ({
	useStore: useMockStore,
}));

describe('MobileFileDrawer', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.storeState.mobileFileTreeOpen = true;
	});

	it('closes when clicking the shared backdrop', async () => {
		const user = userEvent.setup();

		render(
			<>
				<GlobalDialogBackdrop />
				<MobileFileDrawer>
					<div>Files</div>
				</MobileFileDrawer>
			</>,
		);

		expect(screen.getByText('Files')).toBeInTheDocument();

		await user.click(screen.getByTestId('modal-backdrop'));

		expect(mocks.toggleMobileFileTree).toHaveBeenCalledTimes(1);
	});
});
