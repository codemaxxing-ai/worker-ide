import { expect, waitFor, within } from 'storybook/test';

import { Collapsible } from './collapsible';
import { LoadingBars } from './loading-bars';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
	title: 'UI/LoadingBars',
	component: LoadingBars,
} satisfies Meta<typeof LoadingBars>;

export default meta;
type Story = StoryObj<typeof meta>;

async function expectBarsToAnimate(canvasElement: HTMLElement) {
	const bars = within(canvasElement).getByRole('status').querySelectorAll(':scope > div');
	await expect(bars).toHaveLength(5);
	const initialStyles = Array.from(bars, (bar) => ({
		height: getComputedStyle(bar).height,
		opacity: getComputedStyle(bar).opacity,
	}));
	await waitFor(async () => {
		for (const [index, bar] of bars.entries()) {
			await expect(getComputedStyle(bar).height).not.toBe(initialStyles[index].height);
			await expect(getComputedStyle(bar).opacity).not.toBe(initialStyles[index].opacity);
		}
	});
}

export const Default: Story = {
	play: async ({ canvasElement }) => {
		await expectBarsToAnimate(canvasElement);
	},
};

export const InitiallyOpenCollapsible: Story = {
	render: () => (
		<Collapsible open>
			<LoadingBars />
		</Collapsible>
	),
	play: async ({ canvasElement }) => {
		await expectBarsToAnimate(canvasElement);
	},
};
