import { expect, waitFor, within } from 'storybook/test';

import { Collapsible } from '@/components/ui/collapsible';

import { BouncingDots } from './bouncing-dots';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
	title: 'Features/Agent/BouncingDots',
	component: BouncingDots,
} satisfies Meta<typeof BouncingDots>;

export default meta;
type Story = StoryObj<typeof meta>;

async function expectDotsToAnimate(canvasElement: HTMLElement) {
	const dots = within(canvasElement).getByLabelText('Processing speech').children;
	await expect(dots).toHaveLength(3);
	const initialOpacities = Array.from(dots, (dot) => getComputedStyle(dot).opacity);
	await waitFor(async () => {
		for (const [index, dot] of [...dots].entries()) {
			await expect(getComputedStyle(dot).opacity).not.toBe(initialOpacities[index]);
		}
	});
}

export const Default: Story = {
	play: async ({ canvasElement }) => {
		await expectDotsToAnimate(canvasElement);
	},
};

export const InitiallyOpenCollapsible: Story = {
	render: () => (
		<Collapsible open>
			<BouncingDots />
		</Collapsible>
	),
	play: async ({ canvasElement }) => {
		await expectDotsToAnimate(canvasElement);
	},
};
