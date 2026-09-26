import { useEffect } from 'react';
import { expect, userEvent, within } from 'storybook/test';

import { useStore } from '@/lib/store';

import { MobileFileDrawer } from './mobile-file-drawer';
import { Button } from '../../components/ui/button';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
	title: 'Core/MobileFileDrawer',
	component: MobileFileDrawer,
	parameters: {
		layout: 'fullscreen',
	},
} satisfies Meta<typeof MobileFileDrawer>;

export default meta;
type Story = StoryObj<typeof meta>;

const MobileFileDrawerDemo = () => {
	const toggleMobileFileTree = useStore((state) => state.toggleMobileFileTree);

	useEffect(() => {
		if (!useStore.getState().mobileFileTreeOpen) {
			toggleMobileFileTree();
		}
	}, [toggleMobileFileTree]);

	return (
		<div className="flex h-screen items-center justify-center bg-bg-primary">
			<Button onClick={toggleMobileFileTree}>Toggle Drawer</Button>
			<MobileFileDrawer>
				<div className="p-4">
					<h2 className="mb-4 text-lg font-bold">Files</h2>
					<div className="flex flex-col gap-2">
						<div
							className="
								cursor-pointer rounded-sm p-2 text-sm
								hover:bg-bg-tertiary
							"
						>
							src/
						</div>
						<div
							className="
								cursor-pointer rounded-sm p-2 text-sm
								hover:bg-bg-tertiary
							"
						>
							public/
						</div>
						<div
							className="
								cursor-pointer rounded-sm p-2 text-sm
								hover:bg-bg-tertiary
							"
						>
							package.json
						</div>
					</div>
				</div>
			</MobileFileDrawer>
		</div>
	);
};

export const Default: Story = {
	args: {
		children: <div />,
	},
	render: () => <MobileFileDrawerDemo />,
	play: async () => {
		const body = within(document.body);
		const filesTitle = await body.findByText('Files');
		await expect(filesTitle).toBeInTheDocument();

		const sourceDirectory = body.getByText('src/');
		await expect(sourceDirectory).toBeInTheDocument();

		await userEvent.keyboard('{Escape}');
	},
};
